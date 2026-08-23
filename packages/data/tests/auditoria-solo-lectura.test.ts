/**
 * `registrarUsoSoloLectura` — ADR-0002 R42, el rastro que reemplaza al genérico
 * `logger.warn('db.job.bypassrls', …)` para un motivo de `conJob` que necesita dejar constancia de
 * qué leyó (alcance y volumen), cuando `leerConAuditoria` no puede cubrirlo porque `conJob` siempre
 * construye su `Tx` con `usuarioId: null`.
 *
 * No necesita base de datos: es un test de la función y del contrato de tipos del logger acotado,
 * mismo patrón que `packages/shared/tests/redactor.test.ts` para capturar la salida del logger.
 */

import { describe, expect, it } from 'vitest';
import { configurarEmisor } from '@sistema-contable/shared/observabilidad';
import { registrarUsoSoloLectura } from '../src/db/auditoria-solo-lectura.ts';

function capturar(fn: () => void): string {
  const lineas: string[] = [];
  const anterior = configurarEmisor((l) => lineas.push(l));
  const nivelAnterior = process.env['LOG_LEVEL'];
  process.env['LOG_LEVEL'] = 'debug'; // se captura el nivel `info` del evento
  try {
    fn();
  } finally {
    configurarEmisor(anterior);
    if (nivelAnterior === undefined) delete process.env['LOG_LEVEL'];
    else process.env['LOG_LEVEL'] = nivelAnterior;
  }
  return lineas.join('\n');
}

// Uuid sintéticos, claramente inventados — nunca un cliente real (mismo criterio que el resto del
// repo: `gen_random_uuid()` en fixtures de base, literal inventado acá donde no hay base).
const CLIENTE_A = '00000000-0000-4000-8000-000000000001';
const CLIENTE_B = '00000000-0000-4000-8000-000000000002';

describe('registrarUsoSoloLectura (R42)', () => {
  it('emite auditoria_solo_lectura.uso en info, con motivo, entorno, ocurrido_en, alcance y volumen', () => {
    const salida = capturar(() => {
      registrarUsoSoloLectura({
        motivoJob: 'auditoria_seguridad_readonly',
        clienteIds: [CLIENTE_A, CLIENTE_B],
        filasLeidas: 4213,
        detalle: 'medicion-incidente-11',
      });
    });

    expect(salida).toContain('INFO auditoria_solo_lectura.uso');
    expect(salida).toContain('motivo_job=auditoria_seguridad_readonly');
    // `APP_ENTORNO` lo fija `tools/setup-tests.ts` en 'local' para toda la suite.
    expect(salida).toContain('entorno=local');
    expect(salida).toContain(`cliente_ids=[${CLIENTE_A},${CLIENTE_B}]`);
    expect(salida).toContain('filas_leidas=4213');
    expect(salida).toContain('detalle=medicion-incidente-11');

    // `ocurrido_en` lo calcula la función, no el llamador: se verifica la FORMA (ISO 8601), no un
    // valor fijo — depende del instante real de la llamada.
    const match = /ocurrido_en=(\S+)/.exec(salida);
    expect(match).not.toBeNull();
    const valor = match?.[1] ?? '';
    expect(new Date(valor).toISOString()).toBe(valor);
  });

  it('sin `detalle`, el campo no aparece en la línea (no se inventa un valor)', () => {
    const salida = capturar(() => {
      registrarUsoSoloLectura({
        motivoJob: 'auditoria_seguridad_readonly',
        clienteIds: [],
        filasLeidas: 0,
      });
    });

    expect(salida).toContain('cliente_ids=[]');
    expect(salida).toContain('filas_leidas=0');
    expect(salida).not.toContain('detalle=');
  });

  it('rechaza un conteo de filas negativo o no entero: no es un dato que se pueda representar así', () => {
    expect(() =>
      registrarUsoSoloLectura({ motivoJob: 'auditoria_seguridad_readonly', clienteIds: [], filasLeidas: -1 }),
    ).toThrow();
    expect(() =>
      registrarUsoSoloLectura({ motivoJob: 'auditoria_seguridad_readonly', clienteIds: [], filasLeidas: 1.5 }),
    ).toThrow();
  });

  it('rechaza un `clienteIds` con un valor que no tiene forma de uuid', () => {
    expect(() =>
      registrarUsoSoloLectura({
        motivoJob: 'auditoria_seguridad_readonly',
        clienteIds: ['no-es-un-uuid'],
        filasLeidas: 0,
      }),
    ).toThrow();
  });

  it('rechaza un `detalle` más largo que el tope (100): es una etiqueta de corrida, no contenido', () => {
    expect(() =>
      registrarUsoSoloLectura({
        motivoJob: 'auditoria_seguridad_readonly',
        clienteIds: [],
        filasLeidas: 0,
        detalle: 'x'.repeat(101),
      }),
    ).toThrow();

    // El tope exacto pasa: la validación es `> 100`, no `>= 100`.
    expect(() =>
      registrarUsoSoloLectura({
        motivoJob: 'auditoria_seguridad_readonly',
        clienteIds: [],
        filasLeidas: 0,
        detalle: 'x'.repeat(100),
      }),
    ).not.toThrow();
  });

  /**
   * El logger acotado invierte la lógica de un blocklist: la unión de campos permitidos es CERRADA y
   * cualquier otra clave no compila (`logger.ts` líneas ~128-149). Acá se prueba a través del tipo
   * público `DatosUsoSoloLectura`, que es tan cerrado como el logger que envuelve.
   */
  it('el TIPO rechaza un campo fuera del contrato', () => {
    registrarUsoSoloLectura({
      motivoJob: 'auditoria_seguridad_readonly',
      clienteIds: [CLIENTE_A],
      filasLeidas: 1,
      // @ts-expect-error — `cuit` no es un campo de `DatosUsoSoloLectura`: esto no puede compilar. Si
      // algún día compilara, el test falla, que es exactamente lo que queremos.
      cuit: '20123456789',
    });
  });

  /**
   * `MotivoJob` es una unión cerrada (R19): `'ingesta_bancaria'` no está a propósito. Este tipo hereda
   * esa misma cerradura porque `motivoJob` es un `MotivoJob`, no un `string` suelto.
   */
  it('el TIPO rechaza un motivoJob que no es un MotivoJob válido', () => {
    registrarUsoSoloLectura({
      // @ts-expect-error — 'ingesta_bancaria' no está en MotivoJob (R19): esto no puede compilar.
      motivoJob: 'ingesta_bancaria',
      clienteIds: [CLIENTE_A],
      filasLeidas: 1,
    });
  });
});
