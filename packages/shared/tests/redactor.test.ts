/**
 * TESTS DEL PUNTO 3 — registro de clasificación, redactor y logger (ADR-0002 §A.3, §D, INV-8).
 *
 * El test central es el último: recorre los TRES caminos dorados del dominio (ingesta de un extracto,
 * error de conciliación, consulta de padrón), incluidas sus rutas de falla, captura TODO lo que emite
 * el logger, y verifica dos cosas:
 *
 *   1. que ningún valor del fixture sensible aparezca en la salida;
 *   2. que SÍ aparezcan `request_id`, `cliente_id`, `lote_id` y el código de error — porque un test
 *      que solo verifica (1) se pasa "no logueando nada", y entonces no se puede depurar.
 */

import { describe, expect, it } from 'vitest';
import {
  CLASIFICACION,
  CLAVES_SENSIBLES_EXTERNAS,
  COLUMNAS_SENSIBLES,
  contieneDatoSensible,
  cuitParcial,
  esClaveSensible,
  MARCA,
  redactar,
  redactarTexto,
  ultimos4,
  type NombreTabla,
} from '../src/seguridad/index.ts';
import { configurarEmisor, logger } from '../src/observabilidad/index.ts';

// -----------------------------------------------------------------------------
describe('registro de clasificación', () => {
  it('COLUMNAS_SENSIBLES contiene todas las columnas ≥ N2 y ninguna N0/N1', () => {
    const esperadas = new Set<string>();
    const prohibidas = new Set<string>();

    for (const tabla of Object.keys(CLASIFICACION) as NombreTabla[]) {
      for (const [columna, campo] of Object.entries(CLASIFICACION[tabla].campos)) {
        if (campo.nivel === 'N0' || campo.nivel === 'N1') prohibidas.add(columna);
        else esperadas.add(columna);
      }
    }

    for (const c of esperadas) expect(COLUMNAS_SENSIBLES.has(c), `falta ${c}`).toBe(true);
    // Una columna puede ser N1 en una tabla y N2 en otra (`motivo`): solo se exige que no esté marcada
    // como sensible ninguna que sea N0/N1 en TODAS.
    for (const c of prohibidas) {
      if (!esperadas.has(c)) expect(COLUMNAS_SENSIBLES.has(c), `${c} no debería ser sensible`).toBe(false);
    }
  });

  it('material_cifrado está clasificado N3', () => {
    expect(CLASIFICACION.credencial_fiscal.campos.material_cifrado.nivel).toBe('N3');
  });
});

// -----------------------------------------------------------------------------
describe('redactor — por nombre de clave', () => {
  it('tapa las claves sensibles y deja pasar los identificadores internos', () => {
    const salida = redactar({
      request_id: '8f2a',
      cliente_id: '7ab4c0de-0000-0000-0000-000000000001',
      lote_id: '9c31',
      cuit: '30-12345678-9',
      cbu: '0170123400000012345678',
      importe: '1482350.00',
      descripcion: 'TRANSFERENCIA DE PROVEEDORES DEL SUR SRL',
      material_cifrado: 'AAAA',
    }) as Record<string, unknown>;

    expect(salida['request_id']).toBe('8f2a');
    expect(salida['cliente_id']).toBe('7ab4c0de-0000-0000-0000-000000000001');
    expect(salida['lote_id']).toBe('9c31');
    for (const clave of ['cuit', 'cbu', 'importe', 'descripcion', 'material_cifrado']) {
      expect(salida[clave], `${clave} no fue redactada`).toBe(MARCA);
    }
  });

  it('reconoce la clave escrita de cualquier forma (camelCase, guiones, mayúsculas)', () => {
    const salida = redactar({
      razonSocial: 'X',
      'RAZON-SOCIAL': 'X',
      razon_social: 'X',
    }) as Record<string, unknown>;
    for (const v of Object.values(salida)) expect(v).toBe(MARCA);
  });
});

// -----------------------------------------------------------------------------
describe('redactor — por forma del valor (el caso que más se filtra)', () => {
  it('tapa un CUIT y un CBU dentro de un texto libre', () => {
    const { texto, detectores } = redactarTexto(
      'no se pudo imputar el pago de 30-12345678-9 a la cuenta 0170123400000012345678',
    );
    expect(texto).not.toContain('30-12345678-9');
    expect(texto).not.toContain('0170123400000012345678');
    expect(detectores).toContain('cuit');
    expect(detectores).toContain('cbu');
  });

  it('tapa el DETAIL de un error de Postgres, que trae valores de fila (R28)', () => {
    // Éste es el caso real: nadie loguea el CBU a propósito; lo loguea el driver.
    const detalle =
      'duplicate key value violates unique constraint "uq_mov_hash" ' +
      'DETAIL: Key (cliente_id, cbu)=(7ab4, 0170123400000012345678) already exists.';
    expect(contieneDatoSensible(detalle)).toBe(true);
    expect(redactarTexto(detalle).texto).not.toContain('0170123400000012345678');
  });

  it('tapa una clave privada, un JWT y un DSN con contraseña', () => {
    expect(contieneDatoSensible('-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----')).toBe(true);
    expect(contieneDatoSensible('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk')).toBe(true);
    expect(contieneDatoSensible('postgres://app_request:secreto123@db.interno:5432/contable')).toBe(true);
  });

  it('un Error se reduce a nombre + mensaje redactado, SIN stack', () => {
    const e = new Error('fallo con cuit 30-12345678-9');
    const salida = redactar(e) as Record<string, unknown>;
    expect(salida['nombre']).toBe('Error');
    expect(String(salida['mensaje'])).not.toContain('30-12345678-9');
    expect(salida).not.toHaveProperty('stack');
  });

  it('no rompe con estructuras profundas ni cíclicas por profundidad', () => {
    const profundo = { a: { b: { c: { d: { e: { f: { g: { h: { i: 'fondo' } } } } } } } } };
    expect(() => redactar(profundo)).not.toThrow();
  });
});

// -----------------------------------------------------------------------------
/**
 * LA FUGA DE LA CORRIDA LARGA — encontrada en un barrido proactivo, no en un incidente.
 *
 * `cbu` y `cuit` anclan con `\b` a los dos lados. El límite izquierdo estaba: lo que faltaba era que
 * una corrida MÁS LARGA que la publicada rompe el `\b` derecho y **no matchea ningún detector** — ni
 * el propio, ni ningún otro. `glosa.ts` (`packages/ingesta/src/glosa.ts`) ya tenía el catch-all que
 * tapa esto; acá no había llegado.
 *
 * El signo del error se invierte según el lado: en un LECTOR un límite faltante captura de más y se
 * nota (el error de los cuatro rostros de `09` §1); en un REDACTOR captura de MENOS y no se nota
 * nunca. Por cada caso: el publicado (que ya funcionaba) y el mismo valor con un dígito de más (que
 * antes de este fix pasaba entero).
 */
describe('la corrida larga: el catch-all que faltaba propagar desde glosa.ts', () => {
  it('CBU de 22 se tapa (caso publicado, ya funcionaba)', () => {
    const { texto, detectores } = redactarTexto('cuenta 0070012345678901234567 ok');
    expect(texto).toBe('cuenta [REDACTADO] ok');
    expect(detectores).toContain('cbu');
  });

  it('🔴 CBU de 23 (un dígito más) — antes pasaba entero, ahora lo tapa el catch-all', () => {
    const { texto, detectores } = redactarTexto('cuenta 00700123456789012345678 ok');
    expect(texto).toBe('cuenta [REDACTADO] ok');
    expect(texto).not.toContain('00700123456789012345678');
    expect(detectores).toContain('corrida_larga');
  });

  it('CUIT válido se tapa (caso publicado, ya funcionaba)', () => {
    const { texto, detectores } = redactarTexto('cliente 20-99999999-5 ok');
    expect(texto).toBe('cliente [REDACTADO] ok');
    expect(detectores).toContain('cuit');
  });

  it('🔴 CUIT con un dígito pegado — antes pasaba entero, ahora lo tapa el catch-all', () => {
    const { texto, detectores } = redactarTexto('cliente 209999999955 ok');
    expect(texto).toBe('cliente [REDACTADO] ok');
    expect(texto).not.toContain('209999999955');
    expect(detectores).toContain('corrida_larga');
  });

  it('una glosa realista con la corrida pegada al texto también queda tapada', () => {
    // Es la forma en que el hallazgo se manifestaría de verdad: no un valor aislado, sino dentro de
    // una descripción de movimiento que terminó en un log de error.
    const { texto } = redactarTexto('TRANSF 00700123456789012345678 CTA');
    expect(texto).not.toContain('00700123456789012345678');
  });

  it('un conteo de diagnóstico corto (4-6 dígitos) sigue sin taparse: fuera del rango de CUIT/DNI', () => {
    const { texto, detectores } = redactarTexto('archivo_bytes=123456');
    expect(texto).toBe('archivo_bytes=123456');
    expect(detectores).toHaveLength(0);
  });

  it('NO tapa un importe en formato argentino, aunque tenga más de 9 dígitos en total', () => {
    // El lookaround excluye la coma decimal: el importe se tapa por su propio detector, y el
    // catch-all no debe además comerse el conteo de dígitos que separa.
    const { texto, detectores } = redactarTexto('saldo 1.234.567.890,50 ok');
    expect(texto).toBe('saldo [REDACTADO] ok');
    expect(detectores).toEqual(['importe_ar']);
  });
});

// -----------------------------------------------------------------------------
describe('el detector de documento (DNI): el hueco que dejaba pasar un dato N2R entero', () => {
  it('🔴 un DNI de 7 dígitos en texto libre — antes pasaba entero, no hay detector que lo taparía', () => {
    const { texto, detectores } = redactarTexto('DNI 1234567 no encontrado');
    expect(texto).toBe('DNI [REDACTADO] no encontrado');
    expect(texto).not.toContain('1234567');
    expect(detectores).toContain('documento');
  });

  it('un DNI de 8 dígitos también se tapa', () => {
    const { texto, detectores } = redactarTexto('Key (titular_documento)=(12345678) already exists.');
    expect(texto).not.toContain('12345678');
    expect(detectores).toContain('documento');
  });

  it('NO se come el decimal de un importe sin separador de miles', () => {
    // El mismo bug que ya se había corregido en glosa.ts: sin excluir la coma, '1234567,89' le entrega
    // sus siete dígitos enteros al detector de documento.
    const { texto, detectores } = redactarTexto('importe 1234567,89 ok');
    expect(texto).toBe('importe 1234567,89 ok');
    expect(detectores).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
describe('enmascarados para pantalla', () => {
  it('ultimos4 y cuitParcial no revelan el dato completo', () => {
    expect(ultimos4('0170123400000012345678')).toBe('••••5678');
    expect(cuitParcial('30-12345678-9')).toBe('30-•••••••-9');
  });
});

// -----------------------------------------------------------------------------
describe('INV-8 — los tres caminos dorados no filtran nada a los logs', () => {
  /** Valores del fixture que NO pueden aparecer en ninguna línea de log. */
  const SENSIBLES = {
    razonSocial: 'EMPRESA DE PRUEBA 07 SA',
    cuit: '30-12345678-9',
    cbu: '0170123400000012345678',
    importe: '1482350.00',
    saldo: '3207114.55',
    descripcion: 'TRANSFERENCIA RECIBIDA DE PROVEEDORES DEL SUR SRL',
    archivo: 'EMPRESA DE PRUEBA 07 SA - Banco X 0170-1234-5678901234 - julio.pdf',
    token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.zzzzzzzzzzz',
  } as const;

  function capturar(fn: () => void): string {
    const lineas: string[] = [];
    const anterior = configurarEmisor((l) => lineas.push(l));
    const nivelAnterior = process.env['LOG_LEVEL'];
    process.env['LOG_LEVEL'] = 'debug'; // se capturan TODOS los niveles, incluido debug
    try {
      fn();
    } finally {
      configurarEmisor(anterior);
      if (nivelAnterior === undefined) delete process.env['LOG_LEVEL'];
      else process.env['LOG_LEVEL'] = nivelAnterior;
    }
    return lineas.join('\n');
  }

  it('ingesta de un extracto bancario', () => {
    const salida = capturar(() => {
      logger.info('ingesta.iniciada', {
        request_id: '8f2a',
        lote_id: '9c31',
        cliente_id: '7ab4',
        formato: 'pdf_banco_x',
        hash8: '1f4c9a02',
        bytes: 284310,
      });
      logger.info('ingesta.parseada', { lote_id: '9c31', movimientos: 142, duracion_ms: 1830 });
      logger.warn('ingesta.sin_match', {
        lote_id: '9c31',
        cantidad: 3,
        movimiento_ids: ['c1d0', '44ab', '7e29'],
        // `motivo_codigo` y no `motivo`: `motivo` es una columna N2 y el tipo del logger la rechaza.
        // El ejemplo de ADR-0002 §D decía `motivo=` y el compilador lo marcó: quedó corregido allá.
        motivo_codigo: 'ordenante_desconocido',
      });
      // La ruta de falla. El error se identifica por CÓDIGO y por lote_id: el nombre del archivo NO
      // se pasa, porque trae la razón social y el número de cuenta (§D lo prohíbe explícitamente).
      logger.error('ingesta.archivo_ilegible', {
        lote_id: '9c31',
        codigo: 'INGESTA_ILEGIBLE',
        formato_esperado: 'pdf_banco_x',
      });
    });

    for (const [nombre, valor] of Object.entries(SENSIBLES)) {
      expect(salida, `se filtró ${nombre}`).not.toContain(valor);
    }
    // Y lo que SÍ tiene que estar, para poder depurar.
    expect(salida).toContain('request_id=8f2a');
    expect(salida).toContain('lote_id=9c31');
    expect(salida).toContain('cliente_id=7ab4');
    expect(salida).toContain('INGESTA_ILEGIBLE');
  });

  it('error de conciliación, incluido el error crudo del driver', () => {
    const errorDelDriver = Object.assign(
      new Error('duplicate key value violates unique constraint "uq_mov_hash"'),
      {
        code: '23505',
        detail: `Key (cliente_id, cbu)=(7ab4, ${SENSIBLES.cbu}) already exists.`,
        where: `insert into movimiento values (${SENSIBLES.importe})`,
        parameters: [SENSIBLES.cuit, SENSIBLES.importe, SENSIBLES.cbu],
      },
    );

    const salida = capturar(() => {
      logger.error(
        'conciliacion.duplicado',
        { cliente_id: '7ab4', movimiento_id: 'c1d0', codigo: 'CONC_DUPLICADO' },
        errorDelDriver,
      );
      logger.warn('conciliacion.ambigua', {
        cliente_id: '7ab4',
        movimiento_id: '44ab',
        candidatos: 3,
        codigo: 'CONC_AMBIGUA',
        accion: 'cola_revision',
      });
    });

    for (const [nombre, valor] of Object.entries(SENSIBLES)) {
      expect(salida, `se filtró ${nombre}`).not.toContain(valor);
    }
    // El `detail`, el `where` y los `parameters` del driver NO se emiten en ningún caso.
    expect(salida).not.toContain('DETAIL');
    expect(salida).not.toContain('insert into movimiento');
    expect(salida).toContain('CONC_DUPLICADO');
    expect(salida).toContain('cola_revision');
  });

  it('consulta de padrón al organismo recaudador', () => {
    const salida = capturar(() => {
      logger.info('padron.consulta', {
        request_id: '8f2a',
        cliente_id: '7ab4',
        sujeto_ref: 'e91b',
        origen: 'conciliacion',
        cache: 'miss',
      });
      logger.info('padron.respuesta', {
        request_id: '8f2a',
        sujeto_ref: 'e91b',
        http: 200,
        duracion_ms: 412,
        campos: 4,
      });
      logger.error(
        'padron.error',
        { request_id: '8f2a', sujeto_ref: 'e91b', http: 503, codigo: 'PADRON_NO_DISPONIBLE' },
        new Error(`GET https://organismo/padron/v2/persona/30123456789?token=${SENSIBLES.token}`),
      );
    });

    for (const [nombre, valor] of Object.entries(SENSIBLES)) {
      expect(salida, `se filtró ${nombre}`).not.toContain(valor);
    }
    // El CUIT sin guiones dentro de una URL también se tapa.
    expect(salida).not.toContain('30123456789');
    expect(salida).toContain('sujeto_ref=e91b');
    expect(salida).toContain('PADRON_NO_DISPONIBLE');
  });

  it('el barrido detectaría una fuga: un log mal escrito la deja ver', () => {
    // Verificación del verificador: si el redactor no existiera, el test tendría que fallar.
    const crudo = `INFO movimiento importe=${SENSIBLES.importe} cbu=${SENSIBLES.cbu}`;
    expect(contieneDatoSensible(crudo)).toBe(true);
  });

  it('detecta un número de cuenta con separadores dentro de un texto libre', () => {
    // Este detector se agregó porque INV-8 falló: el nombre de archivo traía `0170-1234-5678901234`,
    // que NO matchea el patrón de 22 dígitos seguidos.
    const { texto, detectores } = redactarTexto('archivo Banco X 0170-1234-5678901234 julio.pdf');
    expect(detectores).toContain('cuenta_con_separadores');
    expect(texto).not.toContain('0170-1234-5678901234');
  });
});

// -----------------------------------------------------------------------------
describe('LÍMITE CONOCIDO del redactor (encontrado corriendo INV-8)', () => {
  /**
   * Un nombre propio o una razón social es texto SIN PATRÓN: ningún regex lo distingue de una palabra
   * cualquiera. El redactor tapa lo que tiene forma reconocible (CUIT, CBU, PEM, JWT, DSN) y **no
   * puede** tapar "EMPRESA DE PRUEBA 07 SA".
   *
   * Conclusión, y es la que importa: **el redactor es la red, no la defensa.** La defensa son las dos
   * capas de arriba — el tipo cerrado que rechaza la clave en compilación, y la regla de no construir
   * mensajes de error con datos del cliente. Este test existe para que el límite quede escrito y
   * nadie confíe en el redactor para algo que no puede hacer.
   */
  it('NO detecta una razón social suelta: por eso el tipo cerrado es la defensa real', () => {
    expect(contieneDatoSensible('no se pudo abrir el archivo de EMPRESA DE PRUEBA 07 SA')).toBe(false);
  });

  it('el tipo del logger SÍ rechaza la clave, que es donde se corta de verdad', () => {
    // @ts-expect-error — `razon_social` es una clave prohibida: esto NO compila. Si algún día
    // compilara, este test falla, que es exactamente lo que queremos.
    logger.info('prueba.tipo', { razon_social: 'EMPRESA DE PRUEBA 07 SA' });

    // @ts-expect-error — un objeto de dominio completo tampoco entra: ValorLoggeable no admite objetos.
    logger.info('prueba.tipo', { movimiento: { importe: '100', cbu: '0170' } });
  });
});

// -----------------------------------------------------------------------------
/**
 * LA DERIVACIÓN DE `ClaveProhibida` — el agujero que encontró la auditoría de `security-engineer`.
 *
 * `ClaveProhibida` comparaba **literales exactos** contra una lista escrita a mano en el logger, y esa
 * lista **ya había divergido de su propia fuente**: ~32 claves que el redactor tapa en runtime nunca
 * estuvieron en el tipo, ni siquiera en snake_case. Y encima **toda columna multi-palabra compilaba en
 * camelCase**, que es justamente la grafía de los nombres reales del código.
 *
 * No hubo fuga —el redactor las tapaba— pero **R27 no valía**: *"el logger no compila si le pasás una
 * clave ≥ N2"*. R27 es la defensa; el redactor es la red.
 *
 * Ahora `ClaveProhibida = ClaveSensible`, derivado del registro. Estos tests son la verificación del
 * verificador: si alguien vuelve a poner una lista a mano, se caen.
 */
describe('el tipo y el redactor bloquean el MISMO conjunto, en las dos grafías', () => {
  const aCamel = (s: string): string => s.replace(/_(.)/g, (_, c: string) => c.toUpperCase());

  it('toda clave sensible se detecta en snake_case Y en camelCase', () => {
    const todas = [...COLUMNAS_SENSIBLES, ...CLAVES_SENSIBLES_EXTERNAS];
    expect(todas.length).toBeGreaterThan(40);
    for (const c of todas) {
      expect(esClaveSensible(c), `snake: ${c}`).toBe(true);
      expect(esClaveSensible(aCamel(c)), `camel: ${aCamel(c)}`).toBe(true);
    }
  });

  /**
   * Las cuatro combinaciones que la derivación tiene que cubrir. Si alguna compilara, el
   * `@ts-expect-error` sobra y el test falla — que es exactamente lo que queremos.
   */
  it('el TIPO rechaza las cuatro combinaciones', () => {
    // @ts-expect-error — columna ≥ N2, snake_case.
    logger.info('t', { saldo_final_declarado: '1.00' });
    // @ts-expect-error — la MISMA columna en camelCase, que es el nombre real en el código.
    logger.info('t', { saldoFinalDeclarado: '1.00' });
    // @ts-expect-error — clave externa, snake_case.
    logger.info('t', { titular_documento: '20123456789' });
    // @ts-expect-error — la misma en camelCase. Es la peor: no hay detector de DNI en el redactor.
    logger.info('t', { titularDocumento: '20123456789' });
    // @ts-expect-error — la única columna N3 del registro, en camelCase.
    logger.info('t', { materialCifrado: 'x' });
  });

  /**
   * La contracara: si la derivación ensanchara de más, el logger dejaría de aceptar los campos de
   * diagnóstico y el pipeline se quedaría sin observabilidad. Estos SÍ tienen que compilar.
   */
  it('los campos de diagnóstico siguen permitidos', () => {
    logger.info('t', {
      cliente_id: 'uuid',
      lote_id: 'uuid',
      banco_codigo: 'galicia',
      motivo_codigo: 'sin_movimientos',
      filas_leidas: 326,
      archivo_bytes: 1234,
      verificacion_estado: 'cuadra',
    });
    expect(true).toBe(true);
  });
});
