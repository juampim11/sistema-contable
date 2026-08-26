/**
 * `leerCaratula` multi-cuenta — HANDOFF 2026-08-11 (34) y su enmienda tras la convocatoria.
 *
 * 🔴 Ningún identificador real: el CBU y los números de cuenta son sintéticos, tomados de los mismos
 * valores que ya usa `santander.test.ts` (`CUENTA_PESOS`/`CUENTA_DOLARES`), para poder correr la misma
 * cadena literal contra `leerCaratula` (acá) y contra `reconoceSantander` (el adaptador real) sin
 * inventar un formato nuevo — es el guardrail cruzado que pidió `tech-lead` en la convocatoria.
 */

import { describe, expect, it } from 'vitest';
import {
  argumentos,
  clasificarTipo,
  leerCaratula,
  pedirCbuConfirmado,
  pedirValorOculto,
  PedidoDeCbuCancelado,
} from '../src/alta-cuenta.ts';
import { reconoceSantander, type FilaGeometrica, type TextoDelPdf } from '@sistema-contable/ingesta';

const CBU_SINTETICO = '9990000090000000000001';
const CBU_MANUAL_SINTETICO = '9990000090000000000002';
const CUENTA_PESOS = '123-456789/0';
const CUENTA_DOLARES = '987-654321/0';
const PERIODO = 'Periodo: 01/06/2026 al 30/06/2026';

function textoDe(...lineas: readonly string[]): TextoDelPdf {
  return { paginas: [lineas.join('\n')], paginasSinTexto: [], requiereOcr: false };
}

/**
 * Mismos valores sintéticos que ya usa `packages/ingesta/tests/macro.test.ts` (`NRO_USD`/`NRO_ESPECIAL`/
 * `NRO_BANCARIA`, mismos CBU con guión) — no se inventa un formato nuevo, HANDOFF (38).
 */
const NRO_USD_MACRO = '2-000-0000000003-0';
const NRO_ESPECIAL_MACRO = '1-000-0000000001-0';
const NRO_BANCARIA_MACRO = '3-000-0000000002-0';
const CBU_USD_MACRO = '2850000-1-0000000000003-1';
const CBU_ESPECIAL_MACRO = '2850000-1-0000000000001-1';
const CBU_BANCARIA_MACRO = '2850000-1-0000000000002-1';

/** Una sección Macro: cabecera + N renglones con forma de movimiento (`dd/mm/aa ...`) + CBU de la sección. */
function seccionMacro(
  titulo: string,
  numero: string,
  cbu: string,
  cantidadMovimientos: number,
): readonly string[] {
  const movimientos = Array.from(
    { length: cantidadMovimientos },
    (_, i) => `01/06/26 Movimiento sintetico ${i}`,
  );
  return [
    `${titulo} NRO.: ${numero}`,
    ...movimientos,
    `Clave Bancaria Uniforme para Debito Directo: ${cbu}`,
  ];
}

const CARATULA_MACRO_TRES_CUENTAS = [
  PERIODO,
  ...seccionMacro('CUENTA CORRIENTE ESPECIAL EN DOLARES', NRO_USD_MACRO, CBU_USD_MACRO, 0),
  ...seccionMacro('CUENTA CORRIENTE ESPECIAL EN PESOS', NRO_ESPECIAL_MACRO, CBU_ESPECIAL_MACRO, 3),
  ...seccionMacro('CUENTA CORRIENTE BANCARIA', NRO_BANCARIA_MACRO, CBU_BANCARIA_MACRO, 7),
];

const CARATULA_MULTICUENTA = [
  `CBU: ${CBU_SINTETICO}`,
  PERIODO,
  `Cuenta Corriente Nº ${CUENTA_PESOS}`,
  `Cuenta Corriente especial U$S Nº ${CUENTA_DOLARES}`,
];

const CARATULA_SANTANDER_UNA_CUENTA = [
  `CBU: ${CBU_SINTETICO}`,
  PERIODO,
  `Cuenta Corriente Nº ${CUENTA_PESOS}`,
];

const CARATULA_GALICIA = [
  `CBU: ${CBU_SINTETICO}`,
  PERIODO,
  'Número de cuenta',
  '00001234567890',
  'Tipo de cuenta',
  'Cuenta Corriente',
];

/**
 * Bancor NO imprime "Número de cuenta" ni "CBU" como etiqueta (a diferencia de los tres formatos de
 * arriba) — el número (`NNNNN/NN`) y el CBU (22 dígitos) están en la carátula por FORMA, sin rótulo, y
 * `leerCaratula` los lee por GEOMETRÍA (`aFilas`/`FilaGeometrica[]`), no por línea de texto (`aLineas`)
 * — es la única de las cuatro ramas que necesita esto (ver la nota junto a `FILAS_DE_CARATULA_BANCOR`
 * en `alta-cuenta.ts`: `aLineas()` reordena la carátula de Bancor contra el PDF real, medido, no
 * asumido). Mismo criterio ya validado para el adapter en `bancor.ts`.
 */
const NUMERO_CUENTA_BANCOR_SINTETICO = '99999/99';
const CBU_BANCOR_SINTETICO = '9990000090000000000003';

/** Fila geométrica sintética mínima: un fragmento, ancho derivado del texto (mismo criterio que `bancor.test.ts`). */
function filaBancor(texto: string, x: number, pagina = 1, y = 800): FilaGeometrica {
  return { pagina, y, fragmentos: [{ texto, x, y, ancho: texto.length * 5 }] };
}

const FILAS_CARATULA_BANCOR: readonly FilaGeometrica[] = [
  filaBancor('Banco de la Provincia de Córdoba S.A.', 400),
  filaBancor('www.bancor.com.ar', 400),
  filaBancor(NUMERO_CUENTA_BANCOR_SINTETICO, 311.3),
  filaBancor(CBU_BANCOR_SINTETICO, 130.1),
];

describe('argumentos()', () => {
  const base = [
    '--cliente',
    '11111111-1111-1111-1111-111111111111',
    '--usuario',
    '22222222-2222-2222-2222-222222222222',
    '--banco',
    'santander',
    '--archivo',
    'privado/no-existe.pdf',
  ];

  it('--moneda por defecto es ARS', () => {
    expect(argumentos(base).moneda).toBe('ARS');
  });

  it(
    '--cbu ya NO es un argumento válido: se rechaza explícito, nunca en silencio ' +
      '(security-engineer, HANDOFF (36) — z.object sin .strict() lo descartaría sin avisar)',
    () => {
      expect(() => argumentos([...base, '--cbu', CBU_MANUAL_SINTETICO])).toThrow(
        /--cbu ya no es un argumento válido/,
      );
    },
  );

  it('el rechazo de --cbu no depende del valor que traiga (ni siquiera bien formado)', () => {
    expect(() => argumentos([...base, '--cbu', '123'])).toThrow(/--cbu ya no es un argumento válido/);
  });

  it(
    '--cbu=valor (pegado con =) también se rechaza, no solo --cbu valor ' +
      '(code-reviewer, HANDOFF (36) — el loop de parseo lo descartaba en silencio total)',
    () => {
      expect(() => argumentos([...base, `--cbu=${CBU_MANUAL_SINTETICO}`])).toThrow(
        /--cbu ya no es un argumento válido/,
      );
    },
  );
});

describe('clasificarTipo()', () => {
  it('reconoce corriente, especial y cae en no_determinado', () => {
    expect(clasificarTipo('Cuenta Corriente')).toBe('cuenta_corriente');
    expect(clasificarTipo('Cuenta Corriente Especial')).toBe('cuenta_corriente_especial');
    expect(clasificarTipo('Caja de Ahorro')).toBe('caja_ahorro');
    expect(clasificarTipo('algo que no matchea nada')).toBe('no_determinado');
  });
});

describe('leerCaratula() — Galicia, formato de una sola cuenta (regresión: no debe romperse)', () => {
  it('lee número, CBU y tipo por etiqueta, como antes del fix', () => {
    const r = leerCaratula(textoDe(...CARATULA_GALICIA), 'ARS', undefined);
    expect(r.numero).toBe('00001234567890');
    expect(r.cbu).toBe(CBU_SINTETICO);
    expect(r.tipoCuenta).toBe('cuenta_corriente');
    expect(r.seccionUsada).toMatch(/etiqueta genérica/);
  });

  it('sigue fallando si falta el número', () => {
    expect(() =>
      leerCaratula(textoDe(`CBU: ${CBU_SINTETICO}`, PERIODO), 'ARS', undefined),
    ).toThrow(/número de cuenta/);
  });
});

describe('leerCaratula() — Bancor, una sola cuenta, sin etiqueta, por GEOMETRÍA (aFilas, no aLineas)', () => {
  it('lee número y CBU por forma geométrica, sin necesitar moneda/tipo para desambiguar', () => {
    const r = leerCaratula(textoDe(PERIODO), 'ARS', undefined, undefined, FILAS_CARATULA_BANCOR);
    expect(r.numero).toBe(NUMERO_CUENTA_BANCOR_SINTETICO);
    expect(r.cbu).toBe(CBU_BANCOR_SINTETICO);
    expect(r.tipoCuenta).toBe('cuenta_corriente');
    expect(r.seccionUsada).toMatch(/Bancor/);
  });

  it('falla explícito si no encuentra el número (formato NNNNN/NN)', () => {
    const sinNumero = FILAS_CARATULA_BANCOR.filter(
      (f) => f.fragmentos[0]?.texto !== NUMERO_CUENTA_BANCOR_SINTETICO,
    );
    expect(() =>
      leerCaratula(textoDe(PERIODO), 'ARS', undefined, undefined, sinNumero),
    ).toThrow(/número de cuenta/);
  });

  it('falla explícito si no encuentra el CBU (22 dígitos)', () => {
    const sinCbu = FILAS_CARATULA_BANCOR.filter(
      (f) => f.fragmentos[0]?.texto !== CBU_BANCOR_SINTETICO,
    );
    expect(() => leerCaratula(textoDe(PERIODO), 'ARS', undefined, undefined, sinCbu)).toThrow(/CBU/);
  });

  it('un documento de otro banco (sin geometría/letterhead de Bancor) no cae por error en esta rama', () => {
    // `filasGeometricas` por default es `[]` — `reconoceBancor([])` da `false`, cae al camino normal.
    const r = leerCaratula(textoDe(...CARATULA_GALICIA), 'ARS', undefined);
    expect(r.seccionUsada).not.toMatch(/Bancor/);
  });

  it('no busca más allá de la carátula: un número/CBU real corrido más allá de la ventana geométrica no se encuentra', () => {
    const relleno = Array.from({ length: 25 }, (_, i) => filaBancor(`Relleno de cuerpo linea ${i}`, 172.2));
    const conDatosTardios: readonly FilaGeometrica[] = [
      filaBancor('Banco de la Provincia de Córdoba S.A.', 400),
      filaBancor('www.bancor.com.ar', 400),
      ...relleno,
      filaBancor(NUMERO_CUENTA_BANCOR_SINTETICO, 311.3),
      filaBancor(CBU_BANCOR_SINTETICO, 130.1),
    ];
    expect(() =>
      leerCaratula(textoDe(PERIODO), 'ARS', undefined, undefined, conDatosTardios),
    ).toThrow(/número de cuenta/);
  });
});

describe('leerCaratula() — Santander, una sola cuenta en el documento', () => {
  it('no exige un CBU manual: lo lee de la etiqueta como cualquier documento de una sola cuenta', () => {
    const r = leerCaratula(textoDe(...CARATULA_SANTANDER_UNA_CUENTA), 'ARS', undefined);
    expect(r.numero).toBe(CUENTA_PESOS);
    expect(r.cbu).toBe(CBU_SINTETICO);
    expect(r.tipoCuenta).toBe('cuenta_corriente');
    expect(r.seccionUsada).toMatch(/Pesos/);
  });

  it('--moneda USD contra un documento que solo tiene la sección en pesos: falla explícito', () => {
    expect(() => leerCaratula(textoDe(...CARATULA_SANTANDER_UNA_CUENTA), 'USD', undefined)).toThrow(
      /No encontré una sección "Cuenta Corriente" en USD/,
    );
  });
});

describe('leerCaratula() — Santander multi-cuenta (el caso real que motiva el fix)', () => {
  it('--moneda ARS sin CBU manual: falla explícito, nunca atribuye el CBU único a una de las dos cuentas', () => {
    expect(() => leerCaratula(textoDe(...CARATULA_MULTICUENTA), 'ARS', undefined)).toThrow(
      /no se puede atribuir a una sola moneda/,
    );
  });

  it('--moneda USD sin CBU manual: mismo fallo explícito (no es un caso especial de ARS)', () => {
    expect(() => leerCaratula(textoDe(...CARATULA_MULTICUENTA), 'USD', undefined)).toThrow(
      /no se puede atribuir a una sola moneda/,
    );
  });

  it('ARS con CBU manual: usa el número de la sección en pesos, nunca el de dólares', () => {
    const r = leerCaratula(textoDe(...CARATULA_MULTICUENTA), 'ARS', CBU_MANUAL_SINTETICO);
    expect(r.numero).toBe(CUENTA_PESOS);
    expect(r.numero).not.toBe(CUENTA_DOLARES);
    expect(r.tipoCuenta).toBe('cuenta_corriente');
    expect(r.cbu).toBe(CBU_MANUAL_SINTETICO);
    expect(r.seccionUsada).toMatch(/Pesos/);
  });

  it('USD con CBU manual: usa el número de la sección en dólares, nunca el de pesos', () => {
    const r = leerCaratula(textoDe(...CARATULA_MULTICUENTA), 'USD', CBU_MANUAL_SINTETICO);
    expect(r.numero).toBe(CUENTA_DOLARES);
    expect(r.numero).not.toBe(CUENTA_PESOS);
    expect(r.tipoCuenta).toBe('cuenta_corriente_especial');
    expect(r.seccionUsada).toMatch(/U\$S/);
  });

  it('0 cabeceras para la moneda pedida (documento solo trae USD, se pide ARS): falla explícito', () => {
    const soloDolares = [
      `CBU: ${CBU_SINTETICO}`,
      PERIODO,
      `Cuenta Corriente especial U$S Nº ${CUENTA_DOLARES}`,
    ];
    expect(() => leerCaratula(textoDe(...soloDolares), 'ARS', undefined)).toThrow(
      /No encontré una sección "Cuenta Corriente" en ARS/,
    );
  });

  it('>1 número distinto para la misma moneda (cabecera corrupta): falla explícito, no adivina', () => {
    const dosNumerosParaPesos = [
      `CBU: ${CBU_SINTETICO}`,
      PERIODO,
      `Cuenta Corriente Nº ${CUENTA_PESOS}`,
      `Cuenta Corriente Nº 111-222333/4`,
    ];
    expect(() => leerCaratula(textoDe(...dosNumerosParaPesos), 'ARS', CBU_MANUAL_SINTETICO)).toThrow(
      /no puedo elegir uno solo/,
    );
  });

  it('cross-check: si el mismo número aparece en las dos monedas, el filtro no discriminó y aborta', () => {
    const numeroCruzado = [
      `CBU: ${CBU_SINTETICO}`,
      PERIODO,
      `Cuenta Corriente Nº ${CUENTA_PESOS}`,
      `Cuenta Corriente especial U$S Nº ${CUENTA_PESOS}`,
    ];
    expect(() => leerCaratula(textoDe(...numeroCruzado), 'ARS', CBU_MANUAL_SINTETICO)).toThrow(
      /no está discriminando/,
    );
  });

  it('la cabecera repetida (una por página) con el MISMO número no es un error — es el caso normal', () => {
    const repetidaEnDosPaginas = [
      `CBU: ${CBU_SINTETICO}`,
      PERIODO,
      `Cuenta Corriente Nº ${CUENTA_PESOS}`,
      `Cuenta Corriente especial U$S Nº ${CUENTA_DOLARES}`,
      `Cuenta Corriente Nº ${CUENTA_PESOS}`, // p.3: misma cuenta, se repite
    ];
    const r = leerCaratula(textoDe(...repetidaEnDosPaginas), 'ARS', CBU_MANUAL_SINTETICO);
    expect(r.numero).toBe(CUENTA_PESOS);
  });

  it(
    'idempotencia cruzada: sin CBU manual, la alta de USD nunca llega a intentar escribir en la base ' +
      '(prueba de que el guard corta ANTES de altaDeCuentaBancaria, no que la idempotencia "resuelva bien")',
    () => {
      // Documentado en HANDOFF (34), enmienda: si esto no lanzara, altaDeCuentaBancaria devolvería en
      // silencio los ids de la cuenta en pesos ya cargada (mismo cliente_id/pepper_id/cbu_hmac/vigenteDesde).
      expect(() => leerCaratula(textoDe(...CARATULA_MULTICUENTA), 'USD', undefined)).toThrow();
    },
  );
});

describe('guardrail cruzado con santander.ts (tech-lead, HANDOFF (34) enmienda)', () => {
  /**
   * `alta-cuenta.ts` duplica (a propósito, ver su comentario) las regex de detección de cabecera de
   * `santander.ts`, en vez de importarlas. Este test corre la MISMA cadena literal contra `leerCaratula`
   * (arriba, vía `CARATULA_MULTICUENTA`) y contra `reconoceSantander`, la función pública que el
   * adaptador real usa para reconocer el formato — si `santander.ts` cambia `RE_CABECERA_CUENTA` y deja
   * de reconocer esa cadena, este test se pone rojo.
   *
   * 🟡 **Cobertura parcial, a propósito documentada** (code-reviewer, HANDOFF (34) enmienda):
   * `reconoceSantander` solo ejercita `RE_CABECERA_CUENTA`. `RE_NUMERO_CUENTA_EN_CABECERA` y
   * `RE_ES_DOLARES` no tienen ningún cross-check automatizado — hoy verificadas carácter por carácter a
   * mano contra el original, no por este test. Cerrarlo de verdad pide fabricar un `FilaGeometrica[]`
   * completo (encabezado + región + cierre) para correr `leerSantander`, del tamaño de las fixtures de
   * `santander.test.ts` — desproporcionado para este fix puntual. Declarado en
   * `docs/diseno/10-deuda-declarada.md`.
   */
  function filaDeUnFragmento(texto: string, pagina = 1, y = 800): FilaGeometrica {
    return { pagina, y, fragmentos: [{ texto, x: 23, y, ancho: texto.length * 5 }] };
  }

  it('reconoceSantander reconoce la MISMA cabecera que leerCaratula usa para filtrar por moneda', () => {
    const filas: FilaGeometrica[] = [
      filaDeUnFragmento('Movimientos en pesos'),
      filaDeUnFragmento(`Cuenta Corriente Nº ${CUENTA_PESOS}`, 1, 780),
    ];
    expect(reconoceSantander(filas)).toBe(true);
  });

  it('sin la cabecera "Cuenta Corriente...Nº", reconoceSantander NO reconoce (control negativo)', () => {
    const filas: FilaGeometrica[] = [filaDeUnFragmento('Movimientos en pesos')];
    expect(reconoceSantander(filas)).toBe(false);
  });
});

describe('ningún throw de leerCaratula interpola el CBU (seguridad-datos-financieros, HANDOFF (36))', () => {
  /**
   * No alcanza con leer el código a ojo y confirmar que hoy ningún `throw` interpola `cbuManual` — eso es
   * un invariante implícito que un futuro mensaje "más claro" podría romper sin que nadie lo note (mismo
   * patrón que ya causó una fuga real en este repo, ADR-0002 §H.3.bis). Este test lo fija: corre un CBU
   * manual sintético, reconocible y fijo, por cada rama de error de `leerCaratula`, y confirma que NINGÚN
   * mensaje contiene el valor completo ni ninguna corrida de 6+ dígitos consecutivos de él.
   */
  const CBU_TRAZABLE = '9999999999999999999901';

  function sinCorridaDelCbu(mensaje: string): boolean {
    if (mensaje.includes(CBU_TRAZABLE)) return false;
    for (let i = 0; i + 6 <= CBU_TRAZABLE.length; i += 1) {
      if (mensaje.includes(CBU_TRAZABLE.slice(i, i + 6))) return false;
    }
    return true;
  }

  /**
   * Todas las filas pasan `CBU_TRAZABLE` como `cbuManual` — así que la única rama de `leerCaratula` que
   * NO se puede ejercitar acá es "no se puede atribuir a una sola moneda" (esa condición es exactamente
   * `!cbuManual`, y con un CBU manual presente no dispara). No hace falta: en esa rama no hay ningún CBU
   * manual todavía que se pudiera filtrar, así que no hay nada que este test tuviera que verificar ahí.
   */
  const escenarios: ReadonlyArray<{ readonly nombre: string; readonly texto: TextoDelPdf; readonly moneda: 'ARS' | 'USD' }> = [
    {
      nombre: '0 números distintos para la moneda pedida',
      texto: textoDe(`CBU: ${CBU_SINTETICO}`, PERIODO, `Cuenta Corriente especial U$S Nº ${CUENTA_DOLARES}`),
      moneda: 'ARS',
    },
    {
      nombre: '>1 número distinto para la misma moneda',
      texto: textoDe(
        `CBU: ${CBU_SINTETICO}`,
        PERIODO,
        `Cuenta Corriente Nº ${CUENTA_PESOS}`,
        `Cuenta Corriente Nº 111-222333/4`,
      ),
      moneda: 'ARS',
    },
    {
      nombre: 'cross-check: mismo número en las dos monedas',
      texto: textoDe(
        `CBU: ${CBU_SINTETICO}`,
        PERIODO,
        `Cuenta Corriente Nº ${CUENTA_PESOS}`,
        `Cuenta Corriente especial U$S Nº ${CUENTA_PESOS}`,
      ),
      moneda: 'ARS',
    },
    {
      nombre: 'Galicia sin número de cuenta',
      texto: textoDe(`CBU: ${CBU_SINTETICO}`, PERIODO),
      moneda: 'ARS',
    },
    {
      nombre: 'sin período',
      texto: textoDe(`CBU: ${CBU_SINTETICO}`, `Cuenta Corriente Nº ${CUENTA_PESOS}`),
      moneda: 'ARS',
    },
  ];

  it.each(escenarios)('$nombre', ({ texto, moneda }) => {
    let capturado: unknown;
    try {
      leerCaratula(texto, moneda, CBU_TRAZABLE);
    } catch (error) {
      capturado = error;
    }
    expect(capturado).toBeInstanceOf(Error);
    const mensaje = (capturado as Error).message;
    expect(sinCorridaDelCbu(mensaje)).toBe(true);
  });
});

describe('pedirValorOculto() — lectura de stdin en modo raw, sin eco (security-engineer, HANDOFF (36))', () => {
  /** Doble mínimo de `process.stdin`: emite `data` a demanda, sin abrir una terminal real. */
  class EntradaFalsa {
    isTTY: boolean | undefined = true;
    rawMode = false;
    pausada = true;
    private escuchas: Array<(fragmento: string) => void> = [];
    setRawMode(modo: boolean): void {
      this.rawMode = modo;
    }
    resume(): void {
      this.pausada = false;
    }
    pause(): void {
      this.pausada = true;
    }
    setEncoding(): void {}
    on(_evento: 'data', escucha: (fragmento: string) => void): void {
      this.escuchas.push(escucha);
    }
    removeListener(_evento: 'data', escucha: (fragmento: string) => void): void {
      this.escuchas = this.escuchas.filter((e) => e !== escucha);
    }
    emitir(fragmento: string): void {
      for (const escucha of [...this.escuchas]) escucha(fragmento);
    }
    tieneEscuchas(): boolean {
      return this.escuchas.length > 0;
    }
  }

  class SalidaFalsa {
    lineas: string[] = [];
    write(texto: string): boolean {
      this.lineas.push(texto);
      return true;
    }
    toString(): string {
      return this.lineas.join('');
    }
  }

  it('sin terminal interactiva (isTTY false), rechaza de entrada y nunca activa raw mode', async () => {
    const entrada = new EntradaFalsa();
    entrada.isTTY = false;
    const salida = new SalidaFalsa();
    await expect(pedirValorOculto('CBU: ', entrada, salida)).rejects.toThrow(/terminal interactiva/);
    expect(entrada.rawMode).toBe(false);
  });

  it('Enter corta la lectura y devuelve exactamente lo tipeado, sin ecoar el valor a la salida', async () => {
    const entrada = new EntradaFalsa();
    const salida = new SalidaFalsa();
    const promesa = pedirValorOculto('CBU: ', entrada, salida);
    entrada.emitir('1234567890123456789012\r');
    const valor = await promesa;
    expect(valor).toBe('1234567890123456789012');
    expect(salida.toString()).not.toContain('1234567890123456789012');
    expect(entrada.rawMode).toBe(false);
  });

  it('un chunk único con el valor Y el Enter pegados (paste) se corta bien, no se pierde el corte', async () => {
    const entrada = new EntradaFalsa();
    const salida = new SalidaFalsa();
    const promesa = pedirValorOculto('CBU: ', entrada, salida);
    entrada.emitir('9990000090000000000002\r\n');
    await expect(promesa).resolves.toBe('9990000090000000000002');
  });

  it('backspace borra el último carácter tipeado antes de Enter', async () => {
    const DEL = String.fromCharCode(127);
    const entrada = new EntradaFalsa();
    const salida = new SalidaFalsa();
    const promesa = pedirValorOculto('CBU: ', entrada, salida);
    // '1','2','3', DEL (borra el '3'), '4', Enter -> "124"
    entrada.emitir(`123${DEL}4\r`);
    await expect(promesa).resolves.toBe('124');
  });

  it('Ctrl+C cancela con PedidoDeCbuCancelado, restaura rawMode y nunca resuelve con el buffer parcial', async () => {
    const entrada = new EntradaFalsa();
    const salida = new SalidaFalsa();
    const promesa = pedirValorOculto('CBU: ', entrada, salida);
    entrada.emitir('123');
    await expect(promesa).rejects.toBeInstanceOf(PedidoDeCbuCancelado);
    expect(entrada.rawMode).toBe(false);
    expect(entrada.tieneEscuchas()).toBe(false);
  });

  describe('pedirCbuConfirmado() — doble tipeo (seguridad-datos-financieros, HANDOFF (36))', () => {
    async function correr(
      primero: string,
      segundo: string,
    ): Promise<{ resultado: string | undefined; error: Error | undefined; salida: SalidaFalsa }> {
      const entrada = new EntradaFalsa();
      const salida = new SalidaFalsa();
      const promesa = pedirCbuConfirmado(entrada, salida);
      // El primer prompt ya registró su escucha de forma síncrona (el executor de la Promise corre
      // síncrono); el segundo recién se registra después de que el primero resuelve, así que hace falta
      // ceder el control del event loop entre las dos emisiones.
      entrada.emitir(`${primero}\r`);
      await new Promise((r) => setImmediate(r));
      entrada.emitir(`${segundo}\r`);
      try {
        const resultado = await promesa;
        return { resultado, error: undefined, salida };
      } catch (error) {
        return { resultado: undefined, error: error as Error, salida };
      }
    }

    it('las dos veces coinciden y son 22 dígitos: resuelve con el valor', async () => {
      const { resultado, error } = await correr(CBU_MANUAL_SINTETICO, CBU_MANUAL_SINTETICO);
      expect(error).toBeUndefined();
      expect(resultado).toBe(CBU_MANUAL_SINTETICO);
    });

    it('las dos tipeadas NO coinciden: rechaza sin mostrar ninguna de las dos en el mensaje', async () => {
      const otro = '1111111111111111111111';
      const { resultado, error } = await correr(CBU_MANUAL_SINTETICO, otro);
      expect(resultado).toBeUndefined();
      expect(error?.message).toMatch(/no coinciden/);
      expect(error?.message).not.toContain(CBU_MANUAL_SINTETICO);
      expect(error?.message).not.toContain(otro);
    });

    it('coinciden pero no son 22 dígitos: rechaza con mensaje genérico, sin interpolar el valor', async () => {
      const corto = '123';
      const { resultado, error } = await correr(corto, corto);
      expect(resultado).toBeUndefined();
      expect(error?.message).toBe('El CBU tiene que ser de 22 dígitos.');
      expect(error?.message).not.toContain(corto);
    });

    it('imprime la advertencia de no copiar/pegar el CBU en ningún chat o asistente (ADR-0002 §F.2)', async () => {
      const { salida } = await correr(CBU_MANUAL_SINTETICO, CBU_MANUAL_SINTETICO);
      expect(salida.toString()).toMatch(/no lo copies ni lo pegues/i);
    });

    it(
      'no acumula listeners sobre process.exit entre llamadas ' +
        '(code-reviewer, HANDOFF (36) — antes del fix, cada llamada dejaba uno colgado)',
      async () => {
        const antes = process.listenerCount('exit');
        await correr(CBU_MANUAL_SINTETICO, CBU_MANUAL_SINTETICO);
        await correr(CBU_MANUAL_SINTETICO, '1111111111111111111111'); // camino de rechazo también limpia
        await correr(CBU_MANUAL_SINTETICO, CBU_MANUAL_SINTETICO);
        expect(process.listenerCount('exit')).toBe(antes);
      },
    );
  });
});

describe('leerCaratula() — Macro multi-cuenta, tres cuentas y dos ejes (HANDOFF (38))', () => {
  it('USD (una sola candidata): no exige --tipo, atribuye número y CBU limpio de guiones', () => {
    const r = leerCaratula(textoDe(...CARATULA_MACRO_TRES_CUENTAS), 'USD', undefined, undefined);
    expect(r.numero).toBe(NRO_USD_MACRO);
    expect(r.cbu).toBe('2850000100000000000031'); // CBU_USD_MACRO sin guiones, 22 dígitos
    expect(r.cbu).toMatch(/^\d{22}$/);
    expect(r.tipoCuenta).toBe('cuenta_corriente_especial');
    expect(r.seccionUsada).toMatch(/Macro/);
  });

  it('ARS sin --tipo: dos candidatas, falla explícito listando tipo + conteo de movimientos de las DOS', () => {
    expect(() =>
      leerCaratula(textoDe(...CARATULA_MACRO_TRES_CUENTAS), 'ARS', undefined, undefined),
    ).toThrow(
      /Encontré 2 cuentas en ARS.*cuenta_corriente_especial \(3 movimiento\(s\)\).*cuenta_corriente \(7 movimiento\(s\)\)/s,
    );
  });

  it('el mensaje de ambigüedad nunca incluye el número de cuenta ni el CBU', () => {
    let mensaje = '';
    try {
      leerCaratula(textoDe(...CARATULA_MACRO_TRES_CUENTAS), 'ARS', undefined, undefined);
    } catch (error) {
      mensaje = error instanceof Error ? error.message : '';
    }
    expect(mensaje).not.toContain(NRO_ESPECIAL_MACRO);
    expect(mensaje).not.toContain(NRO_BANCARIA_MACRO);
    expect(mensaje).not.toContain(CBU_ESPECIAL_MACRO.replace(/\D/g, ''));
    expect(mensaje).not.toContain(CBU_BANCARIA_MACRO.replace(/\D/g, ''));
  });

  it('ARS con --tipo cuenta_corriente_especial: elige la cuenta de 11→3 movimientos, no la de 1335→7', () => {
    const r = leerCaratula(
      textoDe(...CARATULA_MACRO_TRES_CUENTAS),
      'ARS',
      undefined,
      'cuenta_corriente_especial',
    );
    expect(r.numero).toBe(NRO_ESPECIAL_MACRO);
    expect(r.numero).not.toBe(NRO_BANCARIA_MACRO);
    expect(r.cbu).toBe('2850000100000000000011');
    expect(r.tipoCuenta).toBe('cuenta_corriente_especial');
  });

  it('ARS con --tipo cuenta_corriente: elige la otra cuenta, nunca la especial', () => {
    const r = leerCaratula(
      textoDe(...CARATULA_MACRO_TRES_CUENTAS),
      'ARS',
      undefined,
      'cuenta_corriente',
    );
    expect(r.numero).toBe(NRO_BANCARIA_MACRO);
    expect(r.numero).not.toBe(NRO_ESPECIAL_MACRO);
    expect(r.cbu).toBe('2850000100000000000021');
    expect(r.tipoCuenta).toBe('cuenta_corriente');
  });

  it(
    '--tipo se aplica SIEMPRE que está presente, aunque moneda sola ya alcanzara ' +
      '(security-engineer, HANDOFF (38) — nunca "ignorar tipo porque no hacía falta")',
    () => {
      // USD tiene una sola candidata (especial). Pedir --tipo cuenta_corriente (que no es el de USD)
      // tiene que fallar, no "aceptar igual porque moneda sola ya alcanzaba".
      expect(() =>
        leerCaratula(textoDe(...CARATULA_MACRO_TRES_CUENTAS), 'USD', undefined, 'cuenta_corriente'),
      ).toThrow(/No encontré ninguna cuenta en USD de tipo cuenta_corriente/);
    },
  );

  it('--tipo que no matchea ninguna candidata de la moneda: falla listando lo que sí hay', () => {
    expect(() =>
      leerCaratula(textoDe(...CARATULA_MACRO_TRES_CUENTAS), 'ARS', undefined, 'caja_ahorro'),
    ).toThrow(/cuenta_corriente_especial \(3 movimiento\(s\)\)/);
  });

  it('moneda sin ninguna sección en el documento (formato Macro): falla explícito', () => {
    const soloDolares = [PERIODO, ...seccionMacro('CUENTA CORRIENTE ESPECIAL EN DOLARES', NRO_USD_MACRO, CBU_USD_MACRO, 0)];
    expect(() => leerCaratula(textoDe(...soloDolares), 'ARS', undefined, undefined)).toThrow(
      /No encontré ninguna cuenta en ARS en la carátula \(formato Macro/,
    );
  });

  it('CBU inválido tras limpiar guiones (no da 22 dígitos): falla explícito, no lo acepta a medias', () => {
    const conCbuRoto = [
      PERIODO,
      ...seccionMacro('CUENTA CORRIENTE ESPECIAL EN DOLARES', NRO_USD_MACRO, '123-45', 0),
    ];
    expect(() => leerCaratula(textoDe(...conCbuRoto), 'USD', undefined, undefined)).toThrow(
      /No encontré un CBU válido \(22 dígitos\)/,
    );
  });

  it('formato Galicia/Santander no dispara la rama Macro (0 secciones detectadas, sin falso positivo)', () => {
    // Regresión: confirma que seccionesPorClave no confunde el formato Galicia con el de Macro.
    const r = leerCaratula(
      textoDe(`CBU: ${CBU_SINTETICO}`, PERIODO, 'Número de cuenta', '00001234567890', 'Tipo de cuenta', 'Cuenta Corriente'),
      'ARS',
      undefined,
      undefined,
    );
    expect(r.seccionUsada).toMatch(/etiqueta genérica/);
  });
});
