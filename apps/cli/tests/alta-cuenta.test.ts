/**
 * `leerCaratula` multi-cuenta — HANDOFF 2026-08-11 (34) y su enmienda tras la convocatoria.
 *
 * 🔴 Ningún identificador real: el CBU y los números de cuenta son sintéticos, tomados de los mismos
 * valores que ya usa `santander.test.ts` (`CUENTA_PESOS`/`CUENTA_DOLARES`), para poder correr la misma
 * cadena literal contra `leerCaratula` (acá) y contra `reconoceSantander` (el adaptador real) sin
 * inventar un formato nuevo — es el guardrail cruzado que pidió `tech-lead` en la convocatoria.
 */

import { describe, expect, it } from 'vitest';
import { argumentos, clasificarTipo, leerCaratula } from '../src/alta-cuenta.ts';
import { reconoceSantander, type FilaGeometrica, type TextoDelPdf } from '@sistema-contable/ingesta';

const CBU_SINTETICO = '9990000090000000000001';
const CBU_MANUAL_SINTETICO = '9990000090000000000002';
const CUENTA_PESOS = '123-456789/0';
const CUENTA_DOLARES = '987-654321/0';
const PERIODO = 'Periodo: 01/06/2026 al 30/06/2026';

function textoDe(...lineas: readonly string[]): TextoDelPdf {
  return { paginas: [lineas.join('\n')], paginasSinTexto: [], requiereOcr: false };
}

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

  it('acepta --cbu de 22 dígitos', () => {
    const r = argumentos([...base, '--cbu', CBU_MANUAL_SINTETICO]);
    expect(r.cbu).toBe(CBU_MANUAL_SINTETICO);
  });

  it('rechaza --cbu que no tiene 22 dígitos', () => {
    expect(() => argumentos([...base, '--cbu', '123'])).toThrow(/Argumentos inválidos/);
  });
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

describe('leerCaratula() — Santander, una sola cuenta en el documento', () => {
  it('no exige --cbu: lo lee de la etiqueta como cualquier documento de una sola cuenta', () => {
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
  it('--moneda ARS sin --cbu: falla explícito, nunca atribuye el CBU único a una de las dos cuentas', () => {
    expect(() => leerCaratula(textoDe(...CARATULA_MULTICUENTA), 'ARS', undefined)).toThrow(
      /no se puede atribuir a una sola moneda/,
    );
  });

  it('--moneda USD sin --cbu: mismo fallo explícito (no es un caso especial de ARS)', () => {
    expect(() => leerCaratula(textoDe(...CARATULA_MULTICUENTA), 'USD', undefined)).toThrow(
      /no se puede atribuir a una sola moneda/,
    );
  });

  it('ARS con --cbu: usa el número de la sección en pesos, nunca el de dólares', () => {
    const r = leerCaratula(textoDe(...CARATULA_MULTICUENTA), 'ARS', CBU_MANUAL_SINTETICO);
    expect(r.numero).toBe(CUENTA_PESOS);
    expect(r.numero).not.toBe(CUENTA_DOLARES);
    expect(r.tipoCuenta).toBe('cuenta_corriente');
    expect(r.cbu).toBe(CBU_MANUAL_SINTETICO);
    expect(r.seccionUsada).toMatch(/Pesos/);
  });

  it('USD con --cbu: usa el número de la sección en dólares, nunca el de pesos', () => {
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
    'idempotencia cruzada: sin --cbu, la alta de USD nunca llega a intentar escribir en la base ' +
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
