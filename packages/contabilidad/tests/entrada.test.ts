/**
 * LAS PREDICCIONES FALSABLES DE P0 (plan `quirky-riding-music`).
 *
 * Mismo método que `version.test.ts`, y por el mismo motivo: P0 tiene que poder ponerse ROJO, o no
 * verifica nada. La lección está escrita en `HANDOFF` (52) — la primera versión de una predicción de
 * P0 de `0014` **pasaba en verde con el digest mutado a global**, porque no ejercía nada. Cada `it`
 * de acá se escribió con su interpretación de falla adjunta, y se probó rompiéndolo
 * (`CLAUDE.md` §1.8).
 *
 * 🔴 Ninguna entrada de este archivo lleva material real. Los literales son sintéticos.
 */

import { describe, expect, it } from 'vitest';
import {
  digestDeEntrada,
  proyeccionDeEntrada,
  type EntradaDelMovimiento,
} from '../src/nucleo/entrada.ts';

/** Entrada sintética de referencia. Ningún dato real: `CONCEPTO_X` no existe en ningún léxico. */
const BASE: EntradaDelMovimiento = {
  movimientoId: '00000000-0000-4000-8000-000000000001',
  bancoCodigo: 'galicia',
  conceptoBanco: 'CONCEPTO_X',
  conceptoCompleto: true,
  conceptoBancoEstrategia: 'prefijo_anclado',
  conceptoCodigo: undefined,
  columnaOrigen: 'debito',
  fecha: '2026-03-15',
  contraparteCaptura: 'capturado',
};

/** Los siete campos que SÍ son entrada, con un valor alternativo que difiere del de `BASE`. */
const CAMPOS_DE_ENTRADA = [
  ['conceptoBanco', 'CONCEPTO_Y'],
  ['conceptoCompleto', false],
  ['conceptoBancoEstrategia', 'segmento_de_glosa'],
  ['conceptoCodigo', '123'],
  ['columnaOrigen', 'credito'],
  ['fecha', '2026-03-16'],
  ['contraparteCaptura', 'sin_identificador'],
] as const;

function con(cambios: Partial<Record<string, unknown>>): EntradaDelMovimiento {
  return { ...BASE, ...cambios } as EntradaDelMovimiento;
}

describe('P0 — el determinante de la entrada', () => {
  // ---------------------------------------------------------------------------
  it('(1) es determinístico entre llamadas y sobre un clon sin referencias compartidas', () => {
    const primera = digestDeEntrada(BASE);
    const segunda = digestDeEntrada(BASE);
    const sobreUnClon = digestDeEntrada(structuredClone(BASE) as EntradaDelMovimiento);

    expect(
      segunda,
      'si falla, el digest no es determinístico: hay estado compartido entre llamadas',
    ).toBe(primera);
    expect(
      sobreUnClon,
      'si falla, el digest depende de la identidad de los objetos y no de su contenido',
    ).toBe(primera);
  });

  // ---------------------------------------------------------------------------
  it('(2) la forma es la que el `check` del DDL exige: 16 hex en MINÚSCULA', () => {
    // Es el mismo check que `reconocimiento_digest_chk` (`0014:312`) y el que `0021` va a poner sobre
    // `entrada_digest`. Los dos modos de falla reales: el digest completo sin cortar, y una mayúscula
    // de un `toUpperCase` de camino. Los dos entrarían sin error en una columna `text` y NUNCA
    // matchearían contra el digest recalculado por la base.
    expect(digestDeEntrada(BASE)).toMatch(/^[0-9a-f]{16}$/);
  });

  // ---------------------------------------------------------------------------
  it('(3) 🔴 la IDENTIDAD de la fila NO entra: dos movimientos distintos con la misma entrada dan el MISMO digest', () => {
    const otroMovimiento = con({ movimientoId: '00000000-0000-4000-8000-000000000002' });

    expect(
      digestDeEntrada(otroMovimiento),
      'si falla, el determinante detecta la IDENTIDAD en vez del CAMBIO DE ENTRADA, que es lo único ' +
        'que existe para detectar. Con `movimientoId` adentro, todo reproceso sería fila nueva y la ' +
        'idempotencia de 05 §5.2 se pierde entera.',
    ).toBe(digestDeEntrada(BASE));
  });

  // ---------------------------------------------------------------------------
  it('(4) 🔴 `bancoCodigo` NO entra — está cubierto por `motor_digest`, y vive en OTRA TABLA', () => {
    const otroBanco = con({ bancoCodigo: 'santander' });

    expect(
      digestDeEntrada(otroBanco),
      'si falla, esta función DIVERGE de su gemela en el DDL: `banco_codigo` vive en `lote_ingesta`, ' +
        'y una columna generada de Postgres sólo puede referenciar columnas de la MISMA fila. La ' +
        'divergencia aparecería recién en P1, contra la base, y no acá.',
    ).toBe(digestDeEntrada(BASE));
  });

  // ---------------------------------------------------------------------------
  // 🔴 ESTE ES EL `it` QUE REFUTA UNA LISTA DE INCLUSIÓN MAL ESCRITA. Sin él, olvidar un campo pasa
  // en verde: el digest sigue siendo estable, sigue teniendo 16 hex, y sigue ignorando la identidad.
  it.each(CAMPOS_DE_ENTRADA)('(5) cambiar `%s` MUEVE el digest', (campo, alternativo) => {
    expect(
      digestDeEntrada(con({ [campo]: alternativo })),
      `si falla, \`${campo}\` NO está entrando al digest: el motor lo lee y el determinante no lo ve. ` +
        'Un reproceso que cambie sólo ese campo daría no-op con la interpretación vieja intacta — que ' +
        'es exactamente el bug que `0021` existe para cerrar.',
    ).not.toBe(digestDeEntrada(BASE));
  });

  // ---------------------------------------------------------------------------
  it('(6) 🔴 POR EXCLUSIÓN: un campo NUEVO entra al digest SOLO, sin tocar esta función', () => {
    // Es la prueba de la propiedad, no del caso. Si la construcción fuera por inclusión, agregar una
    // clave no movería nada y el campo nuevo nacería OLVIDADO — el fail-open que `version.ts` §"POR
    // EXCLUSIÓN" documenta y que este archivo hereda.
    const conCampoNuevo = { ...BASE, campoQueTodaviaNoExiste: 'algo' } as unknown as EntradaDelMovimiento;

    expect(
      digestDeEntrada(conCampoNuevo),
      'si falla, la construcción es por INCLUSIÓN de contrabando: el día que el motor lea un campo ' +
        'nuevo, el determinante no lo va a ver y nadie se va a enterar.',
    ).not.toBe(digestDeEntrada(BASE));
  });

  // ---------------------------------------------------------------------------
  it('(7) el encadenado es INYECTIVO: contenido corrido entre campos ADYACENTES no colisiona', () => {
    // 🔴 ESTE `it` NACIÓ DECORATIVO Y SE REESCRIBIÓ POR MUTACIÓN. La primera versión usaba
    // `conceptoBanco` y `conceptoCodigo`, y con el prefijo de longitud sacado (mutación M4) seguía
    // VERDE: en el orden alfabético esos dos NO son adyacentes —se interpone
    // `conceptoBancoEstrategia`—, así que el corrimiento no producía colisión y el test no ejercía
    // nada. Es la misma falla que `HANDOFF` (52) documenta para P0 de `0014`.
    //
    // La colisión de un `join` con separador sólo existe entre campos ADYACENTES: `['a|b','c']` y
    // `['a','b|c']` dan los dos `'a|b|c'`. Acá son `conceptoBanco` (1) y `conceptoBancoEstrategia` (2).
    //
    // ⚠️ El valor de `conceptoBancoEstrategia` va por `as`, y es DELIBERADO: hoy su dominio cerrado
    // vuelve esta colisión inalcanzable desde la base. La regla se enuncia sobre la PROPIEDAD —el
    // encadenado es inyectivo— y no sobre el caso, que es la lección de R25, R33 y las dos primeras
    // redacciones de R36. El día que un campo de texto libre quede adyacente a otro, este test ya está.
    const izquierda = con({ conceptoBanco: 'X', conceptoBancoEstrategia: 'Y|Z' });
    const derecha = con({ conceptoBanco: 'X|Y', conceptoBancoEstrategia: 'Z' });

    expect(
      digestDeEntrada(izquierda),
      'si falla, dos entradas DISTINTAS hashean igual y el determinante deja de discriminar. Es el ' +
        'modo de falla que `hash.ts:17-33` ya documentó para `hashFila()`.',
    ).not.toBe(digestDeEntrada(derecha));
  });

  // ---------------------------------------------------------------------------
  it('(11) la longitud del prefijo se cuenta en PUNTOS DE CÓDIGO, como `length()` de Postgres', () => {
    // `'😀'.length` es 2 en JavaScript (unidades UTF-16) y `length('😀')` es 1 en Postgres. La gemela
    // de esta función vive en una columna generada del DDL: si las dos cuentan distinto, el digest
    // difiere y P1 lo descubre recién contra la base, sobre las pocas filas que traigan un carácter
    // fuera del plano básico.
    expect(proyeccionDeEntrada(con({ conceptoBanco: '😀' }))).toContain('1:😀');
    expect(proyeccionDeEntrada(con({ conceptoBanco: 'ab' }))).toContain('2:ab');
  });

  // ---------------------------------------------------------------------------
  it('(8) el vacío y el ausente NO colisionan', () => {
    const vacio = con({ conceptoBanco: '' });
    const ausente = con({ conceptoBanco: undefined });

    expect(
      digestDeEntrada(vacio),
      'si falla, un `concepto_banco` borrado a cadena vacía es indistinguible de uno nunca capturado',
    ).not.toBe(digestDeEntrada(ausente));
  });

  // ---------------------------------------------------------------------------
  it('(9) `undefined` y `null` colapsan al MISMO digest — en la base los dos son NULL', () => {
    const conUndefined = con({ conceptoCodigo: undefined });
    const conNull = con({ conceptoCodigo: null });

    expect(
      digestDeEntrada(conNull),
      'si falla, P1 va a reportar una divergencia entre TS y SQL que NO es real: la base entrega ' +
        'NULL y el mapeo de `lecturas.ts:318-323` lo convierte en `undefined`.',
    ).toBe(digestDeEntrada(conUndefined));
  });

  // ---------------------------------------------------------------------------
  it('(10) la proyección es reconstruible y no lleva las claves excluidas', () => {
    // La proyección existe para depurar: un digest que cambió no dice QUÉ cambió. Si dejara de ser
    // legible o arrastrara la identidad, no serviría para lo único que justifica exponerla.
    const proyeccion = proyeccionDeEntrada(BASE);

    expect(proyeccion).not.toContain(BASE.movimientoId);
    expect(proyeccion).not.toContain('galicia');
    expect(proyeccion).toContain('CONCEPTO_X');
    // Siete campos ⇒ seis separadores.
    expect(proyeccion.split('|')).toHaveLength(7);
  });
});
