/**
 * GATE DE FIXTURES — condición de salida nº 10.
 *
 * Corre **antes** de que exista el adapter, y eso es a propósito: es lo que impide que el adapter se
 * escriba mirando el archivo real. Si el fixture no existe cuando arranca el parser, el parser se calibra
 * contra el PDF del cliente y termina con sus valores adentro — que es exactamente lo que ya pasó una vez
 * en este repo (ADR-0002 §H.3.bis).
 *
 *     pnpm fixtures:verificar
 *
 * ## Los siete chequeos, y qué mata cada uno
 *
 * | # | Chequeo | El error que evita |
 * |---|---|---|
 * | 1 | Ningún token del material real aparece en el fixture, **comparando normalizado** | Que "generar" haya sido en realidad "copiar y cambiar un dígito". Sin normalizar da falso negativo — pasó en este mismo trabajo |
 * | 2 | CUIT y CBU con **verificador inválido** | Un identificador sintético con verificador válido **puede existir** y pertenecerle a alguien |
 * | 3 | **Allowlist** de nombres propios, no detector | El redactor no puede reconocer una razón social: para los nombres, la única defensa es una lista corta y revisable |
 * | 4 | El fixture **cuadra** | Un fixture cuyos totales no cierran no puede probar la verificación, que es el control que se está construyendo |
 * | 5 | Barrido de detectores sobre el fixture | Cierra lo que tiene forma y la allowlist no cubre |
 * | 6 | `git check-ignore` dice **"no ignorado"** | Un fixture gitignoreado existe en la máquina que lo generó y **no existe en CI**: el test pasa local y falla remoto, o peor, se saltea |
 * | 7 | El fixture conserva la **forma** declarada | Un fixture que perdió los rasgos del formato real no prueba nada: el adapter pasaría el test y fallaría con el archivo del banco |
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contieneDatoSensible, DETECTORES } from '@sistema-contable/shared/seguridad';
import { formaParaLog } from '@sistema-contable/shared/observabilidad';
import { importeACentavos } from '@sistema-contable/ingesta';
import { esFuga, materialReal, type MaterialReal } from './barrido-fuga.ts';
import { raizDelRepo } from './cargar-env.ts';

const RAIZ = raizDelRepo();
const SALTO = String.fromCharCode(10);

const RUTA_FIXTURE = join(RAIZ, 'packages', 'ingesta', 'tests', 'fixtures', 'extracto-sintetico.txt');
const RUTA_ESPERADO = join(
  RAIZ,
  'packages',
  'ingesta',
  'tests',
  'fixtures',
  'extracto-sintetico.esperado.json',
);

/**
 * Nombres propios permitidos en el fixture. **Allowlist, no detector**: el redactor no puede reconocer una
 * razón social (es texto sin patrón), así que la única defensa posible es una lista corta que se pueda
 * revisar de un vistazo. Cualquier nombre que no esté acá es un hallazgo.
 */
const NOMBRES_PERMITIDOS = [
  'BANCO SINTETICO S.A.',
  'EMPRESA DE PRUEBA 07 SRL',
] as const;

/**
 * Palabras del vocabulario bancario que aparecen en el fixture y **no** son nombres propios. Se listan para
 * que el chequeo 3 pueda distinguir "palabra en mayúsculas del formato" de "nombre propio colado".
 */
const VOCABULARIO = new Set(
  (
    'BANCO SINTETICO SA RESUMEN DE CUENTA PERIODO PAGINA FECHA CONCEPTO IMPORTE SALDO TITULAR CUIT ' +
    'CBU ANTERIOR AL FINAL TOTAL CREDITOS DEBITOS TRANSFERENCIA RECIBIDA PAGO A PROVEEDOR DEBITO ' +
    'AUTOMATICO SERVICIO SIMULADO COMISION MANTENIMIENTO ACREDITACION HABERES SIMULADA IMPUESTO LEY ' +
    'RETENCION IIBB JURISDICCION DEPOSITO EN EFECTIVO VENTANILLA REF OPERACION SUCURSAL ORIGEN ' +
    'DETALLE ADICIONAL LA IMPORTANTE ESTE DOCUMENTO ES UNA SIMULACION SIN VALOR LEGAL ANTE CUALQUIER ' +
    'CONSULTA COMUNIQUESE CON SU EMPRESA PRUEBA SRL N'
  ).split(/\s+/),
);

type Resultado = { readonly ok: boolean; readonly detalle: string[] };

function imprimir(t: string): void {
  process.stdout.write(t + SALTO);
}

// -----------------------------------------------------------------------------
// 1. Ningún token del material real
// -----------------------------------------------------------------------------
function chequeo1(texto: string, material: MaterialReal | null): Resultado {
  if (material === null) {
    return {
      ok: true,
      detalle: [
        'privado/ no existe: el cruce contra el material real NO se pudo hacer (modo CI). ' +
          'El chequeo que vale corre en la máquina que tiene el material.',
      ],
    };
  }

  const fugas: string[] = [];
  const lineas = texto.split(/\r?\n/);
  for (let i = 0; i < lineas.length; i += 1) {
    const linea = lineas[i] ?? '';
    for (const d of DETECTORES) {
      const re = new RegExp(d.patron.source, d.patron.flags.includes('g') ? d.patron.flags : `${d.patron.flags}g`);
      for (const m of linea.matchAll(re)) {
        // Se compara NORMALIZADO. Sin normalizar da falso negativo: el mismo importe con y sin puntos de
        // miles se lee distinto, y el chequeo diría "no está" cuando está.
        if (esFuga(m[0], material)) {
          fugas.push(`linea ${i + 1} [${d.nombre}] forma=${formaParaLog(m[0], 40)}`);
        }
      }
    }
  }

  return fugas.length === 0
    ? { ok: true, detalle: [`cruzado contra ${material.tokens.size} tokens del material real`] }
    : { ok: false, detalle: fugas };
}

// -----------------------------------------------------------------------------
// 2. CUIT y CBU con verificador inválido
// -----------------------------------------------------------------------------

/** Verificador de CUIT (módulo 11). Si da válido, el identificador puede existir. */
function cuitTieneVerificadorValido(cuit: string): boolean {
  const d = cuit.replace(/\D/g, '');
  if (d.length !== 11) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i += 1) suma += Number(d[i]) * (pesos[i] ?? 0);
  const resto = suma % 11;
  const esperado = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;
  return Number(d[10]) === esperado;
}

/** Verificador de CBU: dos bloques con sus dígitos de control. */
function cbuTieneVerificadorValido(cbu: string): boolean {
  const d = cbu.replace(/\D/g, '');
  if (d.length !== 22) return false;

  const control = (digitos: string, pesos: readonly number[]): number => {
    let suma = 0;
    for (let i = 0; i < pesos.length; i += 1) suma += Number(digitos[i]) * (pesos[i] ?? 0);
    return (10 - (suma % 10)) % 10;
  };

  const bloque1 = d.slice(0, 8);
  const bloque2 = d.slice(8);
  const ok1 = control(bloque1.slice(0, 7), [7, 1, 3, 9, 7, 1, 3]) === Number(bloque1[7]);
  const ok2 =
    control(bloque2.slice(0, 13), [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3]) === Number(bloque2[13]);
  return ok1 && ok2;
}

function chequeo2(texto: string): Resultado {
  const mal: string[] = [];
  let revisados = 0;

  for (const m of texto.matchAll(/(?<![\d-])(?:\d{2}-\d{8}-\d|\d{11})(?![\d-])/g)) {
    revisados += 1;
    if (cuitTieneVerificadorValido(m[0])) mal.push(`CUIT con verificador VÁLIDO: ${formaParaLog(m[0])}`);
  }
  for (const m of texto.matchAll(/(?<![\d-])\d{22}(?![\d-])/g)) {
    revisados += 1;
    if (cbuTieneVerificadorValido(m[0])) mal.push(`CBU con verificador VÁLIDO: ${formaParaLog(m[0])}`);
  }

  // Si no hay ninguno, el chequeo no verificó nada: un fixture de extracto SIEMPRE tiene identificadores
  // en la carátula, y no tenerlos significa que el generador dejó de producirlos.
  if (revisados === 0) {
    return { ok: false, detalle: ['el fixture no tiene ni un CUIT ni un CBU: el chequeo no probó nada'] };
  }

  return mal.length === 0
    ? { ok: true, detalle: [`${revisados} identificador(es), todos con verificador inválido`] }
    : { ok: false, detalle: mal };
}

// -----------------------------------------------------------------------------
// 3. Allowlist de nombres propios
// -----------------------------------------------------------------------------
function chequeo3(texto: string): Resultado {
  // Se le saca lo permitido y lo que es vocabulario del formato; lo que queda en mayúsculas y no es
  // vocabulario es un nombre propio que nadie declaró.
  let resto = texto;
  for (const permitido of NOMBRES_PERMITIDOS) resto = resto.split(permitido).join(' ');

  const sospechosos = new Set<string>();
  for (const palabra of resto.split(/[^A-ZÁÉÍÓÚÑ]+/)) {
    if (palabra.length < 3) continue;
    if (!VOCABULARIO.has(palabra)) sospechosos.add(palabra);
  }

  return sospechosos.size === 0
    ? { ok: true, detalle: [`${NOMBRES_PERMITIDOS.length} nombre(s) declarado(s), ninguno sin declarar`] }
    : {
        ok: false,
        detalle: [
          `palabras en mayúsculas que no están en la allowlist ni en el vocabulario: ${[...sospechosos]
            .sort()
            .join(', ')}`,
          'Si son legítimas, agregalas a NOMBRES_PERMITIDOS o a VOCABULARIO con criterio.',
        ],
      };
}

// -----------------------------------------------------------------------------
// 4. El fixture cuadra
// -----------------------------------------------------------------------------
function chequeo4(texto: string, esperado: unknown): Resultado {
  const cuentas = (esperado as { cuentas?: readonly Record<string, string | number>[] }).cuentas ?? [];
  if (cuentas.length === 0) {
    return { ok: false, detalle: ['el archivo de respuesta esperada no declara ninguna cuenta'] };
  }

  const problemas: string[] = [];
  for (const [i, c] of cuentas.entries()) {
    const aCent = (v: unknown): bigint | null =>
      typeof v === 'string' ? importeACentavos(v.replace('.', ','), { enteroPelado: true }) : null;

    const inicial = aCent(c['saldoInicial']);
    const final = aCent(c['saldoFinal']);
    const creditos = aCent(c['totalCreditos']);
    const debitos = aCent(c['totalDebitos']);

    if (inicial === null || final === null || creditos === null || debitos === null) {
      problemas.push(`cuenta ${i}: algún total declarado no es un importe canónico`);
      continue;
    }
    // La ecuación de la cuenta. Es la misma que verifica el adapter, y si el fixture no la cumple, el
    // adapter no puede pasar de "no_verificable" y la verificación queda sin probar.
    if (inicial + creditos - debitos !== final) {
      problemas.push(
        `cuenta ${i}: saldo_inicial + creditos - debitos != saldo_final (diferencia de ` +
          `${inicial + creditos - debitos - final} centavos)`,
      );
    }
    if (typeof c['movimientos'] !== 'number' || c['movimientos'] < 1) {
      problemas.push(`cuenta ${i}: cero movimientos declarados`);
    }
  }

  // Y la línea de totales tiene que existir EN EL TEXTO: si el fixture no la trae, el adapter nunca
  // ejercita la verificación contra totales declarados.
  if (!/Total Creditos:/.test(texto) || !/Total Debitos:/.test(texto)) {
    problemas.push('el texto no tiene línea de totales: la verificación queda sin contra qué comparar');
  }

  return problemas.length === 0
    ? { ok: true, detalle: [`${cuentas.length} cuenta(s), la ecuación cierra en todas`] }
    : { ok: false, detalle: problemas };
}

// -----------------------------------------------------------------------------
// 5. Barrido de detectores
// -----------------------------------------------------------------------------
function chequeo5(texto: string): Resultado {
  // El fixture ES un extracto: tiene que matchear detectores (importes, CUIT, CBU). Lo que se verifica no
  // es la ausencia de matches, sino que todo match sea explicable — y eso lo cubren los chequeos 1 y 2.
  // Acá lo que se exige es que el barrido FUNCIONE sobre este archivo: si no matcheara nada, el fixture no
  // se parece a un extracto.
  if (!contieneDatoSensible(texto)) {
    return {
      ok: false,
      detalle: [
        'el barrido no encuentra NADA con forma de dato en el fixture: no se parece a un extracto ' +
          'y por lo tanto no ejercita el parser',
      ],
    };
  }
  return { ok: true, detalle: ['el barrido reconoce el fixture como un extracto'] };
}

// -----------------------------------------------------------------------------
// 6. git check-ignore
// -----------------------------------------------------------------------------
function chequeo6(): Resultado {
  for (const ruta of [RUTA_FIXTURE, RUTA_ESPERADO]) {
    let ignorado = false;
    try {
      execFileSync('git', ['check-ignore', '-q', ruta], { cwd: RAIZ, stdio: 'ignore' });
      ignorado = true; // exit 0 = SÍ está ignorado
    } catch {
      ignorado = false; // exit 1 = no está ignorado, que es lo que se quiere
    }
    if (ignorado) {
      return {
        ok: false,
        detalle: [
          `${ruta} está GITIGNOREADO.`,
          'Un fixture ignorado existe en la máquina que lo generó y NO existe en CI: el test pasa acá y ' +
            'falla allá, o peor, alguien lo saltea. Revisá las reglas de .gitignore.',
        ],
      };
    }
  }
  return { ok: true, detalle: ['el fixture y su respuesta esperada NO están ignorados'] };
}

// -----------------------------------------------------------------------------
// 7. Conserva la forma
// -----------------------------------------------------------------------------
function chequeo7(texto: string): Resultado {
  const rasgos: readonly { readonly nombre: string; readonly presente: boolean }[] = [
    {
      nombre: 'encabezado repetido (más de una página)',
      presente: (texto.match(/RESUMEN DE CUENTA/g) ?? []).length > 1,
    },
    {
      nombre: 'etiqueta de carátula CBU:',
      presente: /CBU:\s*\d/.test(texto),
    },
    {
      nombre: 'etiqueta de carátula CUIT:',
      presente: /CUIT:\s*\d/.test(texto),
    },
    {
      nombre: 'las dos fechas del período PEGADAS sin separador',
      presente: /\d{2}\/\d{2}\/\d{4}\d{2}\/\d{2}\/\d{4}/.test(texto),
    },
    { nombre: 'signo adelante (-1.234,56)', presente: /(?<![\d,.])-\d{1,3}(?:\.\d{3})*,\d{2}/.test(texto) },
    { nombre: 'signo atrás (1.234,56-)', presente: /\d{1,3}(?:\.\d{3})*,\d{2}-/.test(texto) },
    { nombre: 'signo antes del $ (-$ 1.234,56)', presente: /-\$\s\d/.test(texto) },
    { nombre: 'paréntesis ((1.234,56))', presente: /\(\d{1,3}(?:\.\d{3})*,\d{2}\)/.test(texto) },
    {
      nombre: 'glosa multi-línea (continuación sin fecha)',
      presente: /\n {4}[A-Z]/.test(texto),
    },
    { nombre: 'línea de totales', presente: /Total Creditos:/.test(texto) },
    {
      nombre: 'bloque que NO es movimiento',
      presente: /\*\*\* IMPORTANTE/.test(texto),
    },
    {
      nombre: 'variante multi-cuenta',
      presente: (texto.match(/Cuenta Nº/g) ?? []).length > 1,
    },
  ];

  const faltantes = rasgos.filter((r) => !r.presente).map((r) => `falta el rasgo: ${r.nombre}`);
  return faltantes.length === 0
    ? { ok: true, detalle: [`los ${rasgos.length} rasgos del formato están presentes`] }
    : { ok: false, detalle: faltantes };
}

// -----------------------------------------------------------------------------

export function verificarFixtures(): { readonly ok: boolean; readonly resultados: [string, Resultado][] } {
  if (!existsSync(RUTA_FIXTURE) || !existsSync(RUTA_ESPERADO)) {
    return {
      ok: false,
      resultados: [
        [
          '0. el fixture existe',
          {
            ok: false,
            detalle: [
              `Falta ${RUTA_FIXTURE} o su respuesta esperada.`,
              'Se generan con `pnpm fixtures:generar`. El gate corre ANTES del adapter a propósito: si el ' +
                'fixture no existe cuando arranca el parser, el parser se calibra contra el archivo real.',
            ],
          },
        ],
      ],
    };
  }

  const texto = readFileSync(RUTA_FIXTURE, 'utf8');
  const esperado: unknown = JSON.parse(readFileSync(RUTA_ESPERADO, 'utf8'));

  // El MISMO material que cruza el barrido: la función viene de ahí, no se relee acá. Dos lectores del
  // material real divergen, y entonces dos controles que dicen "cruzado contra el material" miran cosas
  // distintas — pasó con la primera versión de este gate.
  const material = materialReal();

  const resultados: [string, Resultado][] = [
    ['1. ningún token del material real (comparando normalizado)', chequeo1(texto, material)],
    ['2. CUIT y CBU con verificador inválido', chequeo2(texto)],
    ['3. allowlist de nombres propios', chequeo3(texto)],
    ['4. el fixture cuadra', chequeo4(texto, esperado)],
    ['5. el barrido reconoce el fixture como extracto', chequeo5(texto)],
    ['6. no está gitignoreado', chequeo6()],
    ['7. conserva la forma del formato real', chequeo7(texto)],
  ];

  return { ok: resultados.every(([, r]) => r.ok), resultados };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('tools/verificar-fixtures.ts');

if (esEjecucionDirecta) {
  const { ok, resultados } = verificarFixtures();
  imprimir('');
  imprimir('  gate de fixtures — 7 chequeos');
  imprimir('');
  for (const [nombre, r] of resultados) {
    imprimir(`  ${r.ok ? 'OK  ' : 'MAL '} ${nombre}`);
    for (const d of r.detalle) imprimir(`         ${d}`);
  }
  imprimir('');
  if (!ok) {
    imprimir('  El fixture NO puede usarse. Corregilo antes de tocar el adapter.');
    imprimir('');
    process.exit(1);
  }
  process.exit(0);
}
