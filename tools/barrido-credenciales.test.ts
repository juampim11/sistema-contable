/**
 * R37 / R37 bis — ningún archivo TRACKEADO contiene una credencial (incidente #3).
 *
 * ## Por qué la mitad de este archivo son repositorios sintéticos
 *
 * Afirmar *"el barrido del repo devuelve cero"* es una aserción sobre el **estado actual**, no sobre
 * la **garantía**. Es exactamente lo que hacía R13 —*"existe el trigger"*, *"el árbol está coherente
 * ahora"*— mientras el agujero seguía abierto, y lo que hizo que R10 pasara verde dos veces con el bug
 * adentro (ADR-0002 §B.1).
 *
 * Un cero puede significar dos cosas: que no hay credenciales, o que el detector no detecta. Para
 * distinguirlas hay que **plantar una y ver que la encuentre**. Cada caso de abajo arma un repo git de
 * verdad en un directorio temporal, le mete exactamente una forma de credencial, y exige que el
 * barrido la nombre. Es la prueba por mutación del propio detector, escrita antes de que hiciera falta.
 *
 * ## Y la vacuidad no es opcional
 *
 * Si `git ls-files` devolviera vacío —repo sin inicializar, ruta equivocada, `execFileSync` que falla
 * en silencio— el barrido daría cero y el gate quedaría verde para siempre. Por eso se afirma
 * primero, con un número, que el barrido **ve** los archivos.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { raizDelRepo } from './cargar-env.ts';
import {
  archivosTrackeados,
  barrer,
  esMarcador,
  negacionesDeEnv,
  NOMBRE_SECRETO,
  PERMITIDOS,
  valoresVivos,
  type Hallazgo,
} from './barrido-credenciales.ts';

const temporales: string[] = [];

afterAll(() => {
  for (const d of temporales) rmSync(d, { recursive: true, force: true });
});

/** Arma un repo git real y trackea los archivos dados. Devuelve la raíz. */
function repoSintetico(archivos: Readonly<Record<string, string>>): string {
  const raiz = mkdtempSync(join(tmpdir(), 'r37-'));
  temporales.push(raiz);
  execFileSync('git', ['init', '-q'], { cwd: raiz });
  for (const [nombre, contenido] of Object.entries(archivos)) {
    const partes = nombre.split('/');
    if (partes.length > 1) mkdirSync(join(raiz, ...partes.slice(0, -1)), { recursive: true });
    writeFileSync(join(raiz, nombre), contenido);
  }
  // `-f` porque algunos casos trackean a propósito un archivo que un `.gitignore` normal ignoraría:
  // el escenario del incidente es justamente ése.
  execFileSync('git', ['add', '-f', '.'], { cwd: raiz });
  return raiz;
}

const formas = (h: readonly Hallazgo[]): string[] => h.map((x) => `${x.forma}:${x.archivo}`);

describe('R37 — el barrido ve los archivos (control de vacuidad)', () => {
  it('git ls-files devuelve los archivos del repo, no una lista vacía', () => {
    const trackeados = archivosTrackeados();
    expect(trackeados.length, 'un barrido sobre cero archivos daría verde para siempre').toBeGreaterThan(100);
    expect(trackeados).toContain('package.json');
  });
});

describe('R37 — el detector encuentra cada forma (prueba por mutación)', () => {
  it('(a) un archivo con forma de .env trackeado', () => {
    const raiz = repoSintetico({ '.env': 'APP_DB_PASSWORD=algo-que-no-es-marcador\n' });
    expect(formas(barrer(raiz))).toContain('archivo-de-entorno:.env');
  });

  it('(a) también con sufijo: .env.produccion', () => {
    const raiz = repoSintetico({ '.env.produccion': 'X=1\n' });
    expect(formas(barrer(raiz))).toContain('archivo-de-entorno:.env.produccion');
  });

  it('(b) una URL con credenciales embebidas, en un archivo cualquiera', () => {
    // Es como viajó el DSN del incidente: la contraseña estaba OTRA VEZ adentro de la URL.
    const raiz = repoSintetico({
      'infra/notas.md': 'conectarse con postgres://un_usuario:una_clave_larga@localhost:5432/db\n',
    });
    expect(formas(barrer(raiz))).toContain('url-con-credencial:infra/notas.md');
  });

  it('(c) una asignación de clave secreta a un literal, en un yml', () => {
    const raiz = repoSintetico({
      'deploy.yml': 'services:\n  api:\n    environment:\n      DB_PASSWORD: una-clave-de-verdad\n',
    });
    expect(formas(barrer(raiz))).toContain('asignacion:deploy.yml');
  });

  it('(c) y en un shell script, que no es .env ni .yml', () => {
    const raiz = repoSintetico({ 'scripts/subir.sh': '#!/bin/sh\nexport API_KEY=abcd1234efgh5678\n' });
    expect(formas(barrer(raiz))).toContain('asignacion:scripts/subir.sh');
  });

  it('NO marca un marcador: es la diferencia entre un template y una credencial', () => {
    const raiz = repoSintetico({
      'docs/plantilla-de-entorno.md': 'DB_PASSWORD=<poner-una-clave>\nAPI_TOKEN=${API_TOKEN}\nOTRO_SECRET=\n',
    });
    // El nombre no tiene forma de `.env`, así que solo se juzga el contenido: son todos marcadores.
    // (Ojo: `.env.plantilla.txt` SÍ tendría forma de archivo de entorno y se marcaría por el nombre,
    // sin mirar el contenido. Es correcto: el sufijo no lo vuelve inofensivo.)
    expect(barrer(raiz)).toEqual([]);
  });

  it('NO marca una referencia de código ni un número', () => {
    const raiz = repoSintetico({
      'src/config.ts': 'const MINIMO_LARGO_TOKEN = 12;\nconst clave = process.env.DB_PASSWORD;\n',
    });
    expect(barrer(raiz)).toEqual([]);
  });
});

describe('R37 — un valor VIVO no lo salva ninguna allowlist', () => {
  it('un literal que coincide con un valor de un .env real se marca aunque esté permitido', () => {
    // 🔴 ESTE es el incidente #3 en una línea: el valor "de ejemplo" y el valor VIVO del piloto eran
    // la misma cadena. Un permitido puede decir "este literal de CI es descartable"; lo que no puede
    // hacer es decidir que un valor que además está vivo en un entorno real es descartable.
    const secreto = 'un-secreto-largo-y-unico-de-prueba-9f2a';
    const raiz = repoSintetico({
      // Se trackea un archivo permitido por nombre y clave...
      '.github/workflows/ci.yml': `env:\n  PGPASSWORD: ${secreto}\n`,
    });
    // ...y se planta el MISMO valor como si fuera el `.env` real de la máquina.
    writeFileSync(join(raiz, '.env'), `APP_DB_PASSWORD=${secreto}\n`);

    const h = barrer(raiz);
    expect(formas(h)).toContain('valor-vivo:.github/workflows/ci.yml');
    expect(
      h.every((x) => x.forma !== 'asignacion'),
      'debe clasificarlo como valor-vivo, que es más grave, no como una asignación cualquiera',
    ).toBe(true);
  });

  it('y sin el .env, ese mismo archivo pasa por el permitido', () => {
    // El contraste es la prueba de que lo que dispara es el valor vivo y no el archivo.
    const raiz = repoSintetico({
      '.github/workflows/ci.yml': 'env:\n  PGPASSWORD: un-secreto-largo-y-unico-de-prueba-9f2a\n',
    });
    expect(barrer(raiz)).toEqual([]);
  });

  it('`valoresVivos` lee los .env de la máquina y no está vacío', () => {
    // Si diera vacío, la comprobación de arriba sería verde por vacuidad en el repo real.
    expect(valoresVivos().size, 'sin valores vivos, la mitad más importante de R37 no mide nada').toBeGreaterThan(0);
  });
});

describe('R37 bis — .gitignore no vuelve a admitir un archivo de entorno', () => {
  it('el .gitignore del repo no tiene ninguna negación sobre .env*', () => {
    expect(
      negacionesDeEnv(),
      'una negación `!.env.algo` es el vector EXACTO del incidente #3: `.env.*` estaba ignorado y ' +
        'un `!.env.example` lo volvió a admitir, con valores reales adentro',
    ).toEqual([]);
  });

  it('y si alguien la reintroduce, se detecta', () => {
    const raiz = repoSintetico({ '.gitignore': '.env\n.env.*\n!.env.example\n*.pem\n' });
    expect(negacionesDeEnv(raiz)).toEqual(['!.env.example']);
  });
});

describe('R37 — la allowlist no acumula entradas muertas', () => {
  it('cada permitido tiene motivo escrito', () => {
    for (const p of PERMITIDOS) {
      expect(p.motivo.length, `el permitido ${p.archivo}/${p.clave} no tiene motivo`).toBeGreaterThan(40);
    }
  });

  it('cada permitido corresponde a un archivo que sigue trackeado', () => {
    // Un permitido sobre un archivo que ya no existe es una excepción que nadie va a revisar, y
    // ablanda la regla para el día que alguien cree un archivo con ese nombre.
    const trackeados = new Set(archivosTrackeados());
    const muertos = PERMITIDOS.filter((p) => !trackeados.has(p.archivo)).map((p) => p.archivo);
    expect(muertos, 'permitidos sobre archivos que ya no están trackeados').toEqual([]);
  });
});

describe('R37 — el generador de `.env` de CI nunca escribe un literal para una clave con forma de secreto', () => {
  /**
   * Extrae los `echo "CLAVE=valor"` del bloque `{ ... } > .env` de `ci.yml` — el paso que genera el
   * `.env` real de esa corrida. No exige el bloque exacto de hoy: cualquier `echo "CLAVE=algo"` futuro
   * dentro de ese bloque entra a la revisión, sin tener que acordarse de agregarlo a mano.
   */
  function asignacionesDelGeneradorDeEnv(textoCiYml: string): ReadonlyArray<{ readonly clave: string; readonly valor: string }> {
    const finDelBloque = textoCiYml.indexOf('} > .env');
    const bloque = finDelBloque === -1 ? textoCiYml : textoCiYml.slice(0, finDelBloque);
    const asignaciones: { clave: string; valor: string }[] = [];
    for (const m of bloque.matchAll(/echo "([A-Z0-9_]+)=([^"]*)"/g)) {
      asignaciones.push({ clave: m[1] ?? '', valor: m[2] ?? '' });
    }
    return asignaciones;
  }

  /**
   * El chequeo real, factorizado para reusarlo en el caso real y en el de mutación de abajo. Respeta
   * `PERMITIDOS` (mismo criterio que `barrer()` para su clase 'asignacion' — acá NO es 'valor-vivo',
   * así que sí corresponde consultar la allowlist; `IDENTIFICADOR_PEPPER_ID=v1` es el caso real que ya
   * está permitido, y sin este chequeo el test lo denuncia igual, un falso positivo).
   */
  function clavesSecretasConLiteral(archivo: string, asignaciones: ReadonlyArray<{ readonly clave: string; readonly valor: string }>): readonly string[] {
    const reSecreto = new RegExp(`^${NOMBRE_SECRETO}$`);
    return asignaciones
      .filter((a) => reSecreto.test(a.clave) && !esMarcador(a.valor))
      .filter((a) => !PERMITIDOS.some((p) => p.archivo === archivo && p.clave === a.clave))
      .map((a) => a.clave);
  }

  it('🔴 caso real (HANDOFF entrada 99): dos veces ya un literal fijo en una clave de forma secreta ' +
    'hizo que `ci.yml` se autodenunciara contra su propio `.env` generado — nunca más', () => {
    const texto = readFileSync(join(raizDelRepo(), '.github/workflows/ci.yml'), 'utf8');
    const asignaciones = asignacionesDelGeneradorDeEnv(texto);
    expect(
      asignaciones.length,
      'no encontré ninguna asignación en el bloque de .env de CI — el parseo se rompió (¿cambió el ' +
        'formato del paso?), revisar a mano antes de confiar en este test',
    ).toBeGreaterThan(5);
    expect(
      clavesSecretasConLiteral('.github/workflows/ci.yml', asignaciones),
      'una clave con forma de secreto en el generador de .env de CI tiene un valor LITERAL — ' +
        'generalo con gen() (openssl rand -hex 24), como el resto del bloque; nunca lo escribas fijo',
    ).toEqual([]);
  });

  it('si alguien reintroduce un literal, el chequeo lo agarra (prueba por mutación, no solo en verde)', () => {
    const conBug = '{\n  echo "S3_LECTURA_ACCESS_KEY_ID=ci_lectura"\n  echo "S3_LECTURA_SECRET_ACCESS_KEY=${LEC_SECRET}"\n} > .env';
    expect(clavesSecretasConLiteral('.github/workflows/ci.yml', asignacionesDelGeneradorDeEnv(conBug))).toEqual(['S3_LECTURA_ACCESS_KEY_ID']);

    const sinBug = '{\n  echo "S3_LECTURA_ACCESS_KEY_ID=${LEC_KEY}"\n  echo "S3_LECTURA_SECRET_ACCESS_KEY=${LEC_SECRET}"\n} > .env';
    expect(clavesSecretasConLiteral('.github/workflows/ci.yml', asignacionesDelGeneradorDeEnv(sinBug))).toEqual([]);
  });
});

describe('R37 — el repo, hoy', () => {
  it('ningún archivo trackeado contiene una credencial', () => {
    const h = barrer();
    expect(
      h.map((x) => `${x.forma} ${x.archivo} ${x.clave} (${x.huella})`),
      'un valor de credencial en un archivo trackeado puede viajar a un remoto. Incidente #3',
    ).toEqual([]);
  });

  it('`esMarcador` no es un colador: reconoce lo que es marcador y rechaza lo que no', () => {
    for (const v of ['', '<poner-una-clave>', '${VAR}', '?falta en .env', '12', 'process.env.X', 'xxxx'])
      expect(esMarcador(v), `${v} debería ser marcador`).toBe(true);
    for (const v of ['app_request_dev', 'sistema_contable_dev', 'aB3xK9mQ7pL2', 'pepper_de_desarrollo_0001'])
      expect(esMarcador(v), `${v} NO debería ser marcador`).toBe(false);
  });
});
