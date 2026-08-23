/**
 * Los detectores de forma (CBU, CUIT, documento/DNI, corrida larga) tienen dos consumidores:
 * `redactar.ts` (tapa en los logs) y `glosa.ts` (extrae de la glosa bancaria). Hasta esta corrección cada
 * uno tenía su propia copia, y ya habían divergido sin que nadie lo notara — el caso medido: el catch-all
 * de 9+ existía en `glosa.ts` y nunca se había propagado a `redactar.ts`, así que un CBU de 23 dígitos o
 * un CUIT con un dígito pegado pasaban ENTEROS a un log (HANDOFF 2026-08-10, la fuga que motivó Parte 0).
 *
 * Este archivo es la regla de código que impide que eso vuelva a pasar, con dos defensas independientes:
 *
 * 1. **Paridad estructural**: los dos archivos importan el MISMO catálogo
 *    (`packages/shared/src/seguridad/detectores-forma.ts`), no una copia con el mismo contenido. Se
 *    afirma sobre el `.source`/`.flags` de cada patrón, y sobre la lista COMPLETA y ordenada de nombres
 *    de `DETECTORES` — así que agregar un detector nuevo en un solo archivo, aunque no tenga nada que ver
 *    con CUIT/CBU, rompe este test y obliga a decidir explícitamente si la clase nueva es "de
 *    identificador" (tiene que estar en los dos) o "de secreto propio del redactor" (PEM/JWT/DSN,
 *    legítimamente asimétrica — no entra al catálogo compartido).
 * 2. **Barrido de comportamiento por longitud**: en vez de una lista curada de casos (que no ejercitaría
 *    una clase agregada después de escribirla), se compara `contieneDatoSensible` (redactor) contra
 *    `contieneIdentificador` (glosa) sobre CADA longitud de 1 a 25 dígitos. Si algún día un detector se
 *    agrega solo de un lado, la longitud que cubre ese detector delata la divergencia sin que nadie tenga
 *    que anticipar el número.
 */

import { describe, expect, it } from 'vitest';
import { contieneDatoSensible, DETECTORES, redactarTexto } from '@sistema-contable/shared/seguridad';
import { RE_CBU, RE_CORRIDA_LARGA, RE_CUIT, RE_DNI } from '@sistema-contable/shared/seguridad';
import { contieneIdentificador, depurarGlosa, PATRONES } from '../src/glosa.ts';

describe('paridad estructural: redactar.ts y glosa.ts importan el MISMO catálogo', () => {
  /**
   * Lista COMPLETA y ordenada, pineada literal. Agregar/quitar/reordenar un detector en `redactar.ts`
   * rompe esta aserción — es la señal de que hay que decidir si el detector nuevo es de identificador
   * (va también en `glosa.ts`) o propio del redactor (PEM/JWT/DSN/base64/importe_ar/cuenta_con_separadores:
   * no tienen contraparte en la glosa bancaria, y está bien que no la tengan).
   */
  it('DETECTORES de redactar.ts: lista completa, en orden', () => {
    expect(DETECTORES.map((d) => d.nombre)).toEqual([
      'clave_privada_pem',
      'clave_privada_pem_parcial',
      'cbu',
      'cuenta_con_separadores',
      'cuit',
      'documento',
      'jwt',
      'dsn_con_credencial',
      'base64_largo',
      'importe_ar',
      'corrida_larga',
    ]);
  });

  /** Mismo pineo del lado de la glosa: agregar una clase quinta sin tocar este test la delata. */
  it('PATRONES de glosa.ts: lista completa, en orden', () => {
    expect(PATRONES.map((p) => p.clase)).toEqual(['cbu', 'cuit', 'documento', 'documento']);
  });

  const CLASES_COMPARTIDAS: readonly { readonly etiqueta: string; readonly nombreEnRedactor: string; readonly patron: RegExp }[] = [
    { etiqueta: 'cbu', nombreEnRedactor: 'cbu', patron: RE_CBU },
    { etiqueta: 'cuit', nombreEnRedactor: 'cuit', patron: RE_CUIT },
    { etiqueta: 'documento (DNI)', nombreEnRedactor: 'documento', patron: RE_DNI },
    { etiqueta: 'corrida_larga (catch-all)', nombreEnRedactor: 'corrida_larga', patron: RE_CORRIDA_LARGA },
  ];

  it.each(CLASES_COMPARTIDAS)(
    'redactar.ts usa exactamente el patrón del catálogo para $etiqueta',
    ({ etiqueta, nombreEnRedactor, patron }) => {
      const enRedactor = DETECTORES.find((d) => d.nombre === nombreEnRedactor);
      expect(enRedactor, `no encontré el detector de ${etiqueta} en DETECTORES`).toBeDefined();
      expect(enRedactor?.patron.source).toBe(patron.source);
      expect(enRedactor?.patron.flags).toBe(patron.flags);
    },
  );

  it('glosa.ts usa exactamente el patrón del catálogo para cbu, cuit y documento', () => {
    const porClase = (clase: string): readonly RegExp[] =>
      PATRONES.filter((p) => p.clase === clase).map((p) => p.re);

    expect(porClase('cbu').map((re) => re.source)).toEqual([RE_CBU.source]);
    expect(porClase('cuit').map((re) => re.source)).toEqual([RE_CUIT.source]);
    // 'documento' tiene DOS entradas en glosa.ts: DNI y el catch-all, en ese orden.
    expect(porClase('documento').map((re) => re.source)).toEqual([
      RE_DNI.source,
      RE_CORRIDA_LARGA.source,
    ]);
  });
});

describe('barrido de comportamiento: mismo booleano en cada longitud, 1 a 25 dígitos', () => {
  /** `X`/`Y` alfabéticos a los dos lados: no interfieren con ningún lookaround (todos excluyen dígitos/separadores, no letras). */
  const conCorrida = (cantidad: number): string => 'X' + '1234567890'.repeat(3).slice(0, cantidad) + 'Y';

  const longitudes = Array.from({ length: 25 }, (_, i) => i + 1);

  it.each(longitudes)('longitud %i: redactor y glosa coinciden', (n) => {
    const texto = conCorrida(n);
    const redactor = contieneDatoSensible(texto);
    const glosa = contieneIdentificador(texto);
    expect(redactor, `longitud ${n}: glosa=${glosa} redactor=${redactor} (texto="${texto}")`).toBe(glosa);
  });

  // Verificación del verificador: si el barrido diera siempre `true` o siempre `false`, el test de arriba
  // pasaría sin comparar nada real.
  it('el barrido SÍ da false en el tramo corto (1-6) y SÍ da true en el tramo largo (7-25)', () => {
    const cortos = [1, 2, 3, 4, 5, 6].map((n) => contieneDatoSensible(conCorrida(n)));
    const largos = [7, 8, 9, 11, 15, 22, 25].map((n) => contieneDatoSensible(conCorrida(n)));
    expect(cortos.every((v) => v === false)).toBe(true);
    expect(largos.every((v) => v === true)).toBe(true);
  });

  it('🔴 el caso que motivó esta regla: un CBU de 23 y un CUIT con un dígito pegado, ya no pasan enteros', () => {
    expect(contieneDatoSensible('cuenta 00700123456789012345678 ok')).toBe(true);
    expect(contieneDatoSensible('cliente 209999999955 ok')).toBe(true);
  });
});

describe('separadores comunes en el CBU: mismo resultado en los dos consumidores', () => {
  const CASOS = [
    // Los dos CBU de acá tienen exactamente 22 dígitos (contados a propósito, no aproximados): agrupados
    // de a 4 con el resto en el último grupo.
    { descripcion: 'CBU con espacios', texto: 'CBU 1234 5678 9012 3456 7890 12 en la carátula' },
    { descripcion: 'CBU con guiones', texto: 'cuenta 9876-5432-1098-7654-3210-98 fin' },
    {
      descripcion: 'CBU pegado a un guión (el caso que reveló la divergencia de estilo entre los dos archivos)',
      texto: 'REF-9990000090000000000001',
    },
  ];

  it.each(CASOS)('$descripcion: redactor y glosa coinciden (los dos detectan)', ({ texto }) => {
    expect(contieneDatoSensible(texto)).toBe(true);
    expect(contieneIdentificador(texto)).toBe(true);
  });

  /**
   * 🔴 **Residuo declarado, no un olvido.** El DNI (7-8 dígitos) NO admite separadores — a diferencia del
   * CBU — porque el formato canónico de importe (`10000.00`: 5 dígitos, un punto, 2 decimales) matchea el
   * mismo patrón que un DNI de 7 dígitos con un punto adentro. Medido en vivo: agregarle separadores al
   * DNI hizo que `tools/barrido-fuga.ts` reportara 34 falsos positivos sobre importes canónicos en todo el
   * repo (ver el comentario de `detectores-forma.ts`). Este test deja el residuo medido, no implícito: un
   * DNI con puntos de miles NO se detecta hoy, en ninguno de los dos consumidores.
   */
  it('un DNI con puntos de miles NO se detecta (residuo declarado): los dos consumidores coinciden en false', () => {
    const texto = 'documento 12.345.678 presentado';
    expect(contieneDatoSensible(texto)).toBe(false);
    expect(contieneIdentificador(texto)).toBe(false);
  });
});

describe('CUIT pegado a una letra: el caso real que \\b no cubría (569/1346 movimientos medidos en Macro)', () => {
  // Prefijo AFIP válido (20) + 8 dígitos de orden + dígito verificador, todo inventado — sin relación con
  // ningún CUIT real.
  const CUIT_SINTETICO = '20111111112';

  it('CUIT sintético pegado a una palabra a la IZQUIERDA (DOC + CUIT): ahora se detecta en los dos consumidores', () => {
    const texto = `DOC${CUIT_SINTETICO}`;
    expect(contieneDatoSensible(texto)).toBe(true);
    expect(contieneIdentificador(texto)).toBe(true);

    const { detectores } = redactarTexto(texto);
    expect(detectores).toContain('cuit');

    const { identificadores } = depurarGlosa(texto);
    expect(identificadores.cuit).toEqual([CUIT_SINTETICO]);
  });

  it('CUIT sintético pegado a una palabra a la DERECHA (CUIT + VARIOS): ahora se detecta en los dos consumidores', () => {
    const texto = `${CUIT_SINTETICO}VARIOS`;
    expect(contieneDatoSensible(texto)).toBe(true);
    expect(contieneIdentificador(texto)).toBe(true);

    const { detectores } = redactarTexto(texto);
    expect(detectores).toContain('cuit');

    const { identificadores } = depurarGlosa(texto);
    expect(identificadores.cuit).toEqual([CUIT_SINTETICO]);
  });

  it('un CUIT con un dígito de más pegado directamente después sigue SIN detectarse como cuit (cae en corrida_larga/catch-all)', () => {
    // Mismo caso que redactor.test.ts:162-167, confirmado acá también del lado de la glosa: el residuo no
    // cambió con el fix de arriba, porque el lookaround sigue excluyendo dígito adyacente (solo se dejó de
    // excluir letra adyacente).
    const texto = 'cliente 209999999955 ok';
    const { detectores } = redactarTexto(texto);
    expect(detectores).toContain('corrida_larga');
    expect(detectores).not.toContain('cuit');

    const { identificadores } = depurarGlosa(texto);
    expect(identificadores.cuit).toEqual([]);
    expect(identificadores.documento).toEqual(['209999999955']);
  });
});

describe('hallazgos de prueba de mutación (2026-08-22): dos mutaciones sobrevivieron a la suite antes de este test', () => {
  /**
   * 🔴 MUTACIÓN SOBREVIVIENTE #1: quitar el lookbehind IZQUIERDO de `RE_CUIT` (`(?<!\d)`) no rompía
   * ningún test existente. El comentario de `detectores-forma.ts` (líneas 117-124) ya explicaba el motivo
   * de este lookbehind — "defensa en profundidad" para no recortar una corrida más larga a un CUIT
   * plausible pero falso si por lo que sea el CBU no se aplicó antes — pero ningún fixture lo ejercitaba
   * de forma AISLADA (un dígito pegado a la izquierda de una forma de CUIT, SIN letra y sin llegar a
   * formar un CBU de 22). Sin el lookbehind, `'920111111112'.match(RE_CUIT)` extrae `'20111111112'`
   * como si fuera un CUIT válido — un dígito de la propia corrida termina "prestándole" el prefijo AFIP
   * a un identificador que no es ese.
   */
  it('un dígito pegado a la IZQUIERDA de una forma de CUIT (sin letra) NO se detecta como cuit: cae en corrida_larga/documento', () => {
    const texto = '920111111112';
    const { detectores } = redactarTexto(texto);
    expect(detectores).toContain('corrida_larga');
    expect(detectores).not.toContain('cuit');

    const { identificadores } = depurarGlosa(texto);
    expect(identificadores.cuit).toEqual([]);
    expect(identificadores.documento).toEqual([texto]);
  });

  /**
   * 🔴 MUTACIÓN SOBREVIVIENTE #2: cambiar el `-?` opcional de `RE_CUIT` por `[-,.]?` (aceptar coma o
   * punto además del guión) tampoco rompía ningún test existente. El comentario de `RE_CUIT` es explícito:
   * la forma publicada es `##-########-#`, únicamente con guión — "no estaba pedido y no está medido
   * contra ningún archivo real con otra convención" — pero no había ningún test que confirmara el
   * RECHAZO de coma o punto como separador. Sin esta guarda, un texto con una coma o un punto en la
   * posición del guión (que en una glosa real sería, con más probabilidad, un importe con decimales, no
   * un CUIT) se detectaría igual como si tuviera guión.
   */
  it.each(['20,11111111,2', '20.11111111.2'])(
    'un CUIT con coma o punto en vez de guión (%s) NO se detecta: la forma publicada es solo con guión',
    (texto) => {
      expect(contieneDatoSensible(texto)).toBe(false);
      expect(contieneIdentificador(texto)).toBe(false);

      const { detectores } = redactarTexto(texto);
      expect(detectores).toHaveLength(0);

      const { identificadores } = depurarGlosa(texto);
      expect(identificadores.cuit).toEqual([]);
    },
  );
});
