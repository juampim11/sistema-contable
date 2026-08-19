/**
 * El registro de adaptadores de liquidación y el vocabulario que lo acompaña — commit 1 del plan 14.
 *
 * Lo que se prueba acá es lo que hace de este registro un control y no un diccionario: que la detección
 * **vete** una declaración incorrecta sin revelar qué encontró, que dos adapters que reconocen el mismo
 * archivo no elijan uno, y que el esquema rechace las formas que el plan declara inaceptables (un importe
 * como número, un concepto fuera del catálogo, un `no_verificable` sin motivo).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  ErrorDeLiquidacion,
  formaDeLineaDeLiquidacion,
} from '../src/liquidaciones/contrato.ts';
import {
  CATALOGO_DE_CONCEPTOS,
  TIPOS_CONCEPTO_LIQUIDACION,
  liquidacionLeidaSchema,
  renglonDeLiquidacionSchema,
  resultadoDeEjeSchema,
} from '../src/liquidaciones/esquema.ts';
import {
  adaptadorDeFormato,
  formatosConAdaptador,
  limpiarRegistroDeLiquidaciones,
  registrarAdaptadorDeLiquidacion,
  resolverAdaptadorDeLiquidacion,
  type AdaptadorDeLiquidacion,
  type EntradaDeLiquidacion,
} from '../src/liquidaciones/registro.ts';

const ENTRADA: EntradaDeLiquidacion = { filas: [] };

function adaptadorFalso(formatoCodigo: string, reconoce: boolean): AdaptadorDeLiquidacion {
  return {
    formatoCodigo,
    version: 1,
    capacidades: {
      traeTotalDelEmisor: true,
      publicaBaseYAlicuotaPorRenglon: true,
      traePercepcionIva: false,
    },
    reconoce: () => reconoce,
    leer: () => ({ liquidaciones: [], lineasNoInterpretadas: [] }),
  };
}

describe('registro de adaptadores de liquidación', () => {
  beforeEach(() => {
    limpiarRegistroDeLiquidaciones();
  });

  it('sin ningún adapter registrado: `sin_adaptador`, con la lista de lo que sí hay', () => {
    const r = resolverAdaptadorDeLiquidacion(ENTRADA, 'visa_debito');
    expect(r.estado).toBe('sin_adaptador');
    if (r.estado !== 'sin_adaptador') throw new Error('estado inesperado');
    expect(r.formatosRegistrados).toEqual([]);
  });

  it('un solo adapter que reconoce y coincide con lo declarado: `encontrado`', () => {
    registrarAdaptadorDeLiquidacion(adaptadorFalso('visa_debito', true));
    const r = resolverAdaptadorDeLiquidacion(ENTRADA, 'visa_debito');
    expect(r.estado).toBe('encontrado');
    if (r.estado !== 'encontrado') throw new Error('estado inesperado');
    expect(r.adaptador.formatoCodigo).toBe('visa_debito');
  });

  it('dos adapters reconocen el mismo documento: `ambiguo`, y NO se elige el primero', () => {
    registrarAdaptadorDeLiquidacion(adaptadorFalso('visa_debito', true));
    registrarAdaptadorDeLiquidacion(adaptadorFalso('cabal_debito', true));
    const r = resolverAdaptadorDeLiquidacion(ENTRADA, 'visa_debito');
    expect(r.estado).toBe('ambiguo');
    if (r.estado !== 'ambiguo') throw new Error('estado inesperado');
    expect([...r.candidatos]).toEqual(['cabal_debito', 'visa_debito']);
  });

  it('el archivo es de otro formato: se veta la declaración y NO se dice cuál se detectó', () => {
    registrarAdaptadorDeLiquidacion(adaptadorFalso('cabal_debito', true));
    const r = resolverAdaptadorDeLiquidacion(ENTRADA, 'visa_debito');
    expect(r.estado).toBe('formato_declarado_no_coincide');
    if (r.estado !== 'formato_declarado_no_coincide') throw new Error('estado inesperado');
    expect(r.declarado).toBe('visa_debito');
    // La propiedad que importa: el resultado no contiene el formato detectado en ningún campo. Decirlo
    // confirmaría el contenido de la carpeta de otro cliente.
    expect(JSON.stringify(r)).not.toContain('cabal');
  });

  it('un adapter que no reconoce el documento no es candidato', () => {
    registrarAdaptadorDeLiquidacion(adaptadorFalso('visa_debito', false));
    expect(resolverAdaptadorDeLiquidacion(ENTRADA, 'visa_debito').estado).toBe('sin_adaptador');
  });

  it('registrar dos veces el mismo formato es un error de programación, no de lectura', () => {
    registrarAdaptadorDeLiquidacion(adaptadorFalso('visa_debito', true));
    expect(() => registrarAdaptadorDeLiquidacion(adaptadorFalso('visa_debito', true))).toThrow(
      /Ya hay un adaptador registrado/,
    );
    // Y no es un ErrorDeLiquidacion: ese vocabulario nombra fallas de lectura de un documento.
    try {
      registrarAdaptadorDeLiquidacion(adaptadorFalso('visa_debito', true));
    } catch (e) {
      expect(e).not.toBeInstanceOf(ErrorDeLiquidacion);
    }
  });

  it('el listado y la búsqueda por código reflejan lo registrado', () => {
    registrarAdaptadorDeLiquidacion(adaptadorFalso('visa_debito', true));
    registrarAdaptadorDeLiquidacion(adaptadorFalso('cabal_debito', false));
    expect(formatosConAdaptador()).toEqual(['cabal_debito', 'visa_debito']);
    expect(adaptadorDeFormato('visa_debito')?.version).toBe(1);
    expect(adaptadorDeFormato('formato_inexistente')).toBeUndefined();
  });
});

describe('ErrorDeLiquidacion', () => {
  it('el mensaje lleva el código y el subsistema, nunca el contenido del documento', () => {
    const e = new ErrorDeLiquidacion('layout_inesperado', 'AAAA <$>');
    expect(e.message).toBe('Liquidacion: layout_inesperado (forma=AAAA <$>)');
    expect(e.codigo).toBe('layout_inesperado');
    expect(e.name).toBe('ErrorDeLiquidacion');
  });

  it('sin forma de línea, el mensaje es solo el código', () => {
    expect(new ErrorDeLiquidacion('sin_texto').message).toBe('Liquidacion: sin_texto');
    expect(new ErrorDeLiquidacion('sin_texto').formaDeLaLinea).toBeUndefined();
  });
});

describe('formaDeLineaDeLiquidacion — la magnitud del importe no llega al log (hallazgo L-1)', () => {
  it('un importe con separador de miles se colapsa a la marca, no a su cantidad de dígitos', () => {
    const forma = formaDeLineaDeLiquidacion('TOTAL LIQUIDADO   1.234.567,89');
    expect(forma).toContain('<$>');
    // Lo que NO puede quedar: la máscara de dígitos, que publica el orden de magnitud.
    expect(forma).not.toContain('#');
  });

  it('dos importes de magnitud MUY distinta producen la misma forma', () => {
    expect(formaDeLineaDeLiquidacion('NETO 12,34')).toBe(
      formaDeLineaDeLiquidacion('NETO 9.876.543,21'),
    );
  });

  it('se conserva la geometría: cantidad de campos, columnas y separadores', () => {
    expect(formaDeLineaDeLiquidacion('ARANCEL  100,00  -25,00')).toBe('AAAAAAA  <$>  <$>');
  });

  it('no toca los enteros sueltos: un número de liquidación sigue siendo forma, no valor', () => {
    const forma = formaDeLineaDeLiquidacion('LIQUIDACION 00012345');
    expect(forma).not.toContain('00012345');
    expect(forma).toContain('#');
  });
});

describe('vocabulario de liquidaciones — lo que el esquema tiene que rechazar', () => {
  const RENGLON_VALIDO = {
    concepto: 'arancel',
    subtipoVenta: 'no_discriminado',
    base: { estado: 'publicado', valor: '1000.00' },
    alicuotaPublicada: { estado: 'no_publicado' },
    monto: '10.00',
    jurisdiccion: { estado: 'no_publicado' },
  };

  it('acepta el renglón con base, alícuota y monto crudos', () => {
    expect(renglonDeLiquidacionSchema.safeParse(RENGLON_VALIDO).success).toBe(true);
  });

  it('rechaza un importe que no sea string decimal con dos decimales', () => {
    expect(
      renglonDeLiquidacionSchema.safeParse({ ...RENGLON_VALIDO, monto: 10 }).success,
    ).toBe(false);
    expect(
      renglonDeLiquidacionSchema.safeParse({ ...RENGLON_VALIDO, monto: '10,00' }).success,
    ).toBe(false);
  });

  it('rechaza un concepto fuera del catálogo cerrado', () => {
    expect(
      renglonDeLiquidacionSchema.safeParse({ ...RENGLON_VALIDO, concepto: 'arancel_inventado' })
        .success,
    ).toBe(false);
  });

  it('la ausencia de dato es un término, no un `undefined`: no hay dos representaciones', () => {
    // `no_publicado` sin `valor` es válido...
    expect(
      renglonDeLiquidacionSchema.safeParse({
        ...RENGLON_VALIDO,
        jurisdiccion: { estado: 'no_publicado' },
      }).success,
    ).toBe(true);
    // ...y `publicado` SIN valor no lo es: no se puede decir "lo publica" sin decir qué.
    expect(
      renglonDeLiquidacionSchema.safeParse({
        ...RENGLON_VALIDO,
        jurisdiccion: { estado: 'publicado' },
      }).success,
    ).toBe(false);
  });

  it('rechaza una moneda que no sea la del corpus medido, en vez de coercionarla', () => {
    const base = {
      numeroDeLiquidacion: { estado: 'no_publicado' },
      fechaPresentacion: '2026-08-19',
      fechaDePago: { estado: 'no_publicado' },
      ventasBrutas: '1000.00',
      netoAcreditado: '900.00',
      renglones: [RENGLON_VALIDO],
      caveatDeComputoFiscal: true,
    };
    expect(liquidacionLeidaSchema.safeParse({ ...base, moneda: 'ARS' }).success).toBe(true);
    expect(liquidacionLeidaSchema.safeParse({ ...base, moneda: 'USD' }).success).toBe(false);
  });

  it('`no_verificable` exige motivo, y cualquier otro estado lo prohíbe', () => {
    const eje = 'checksum_del_emisor';
    expect(
      resultadoDeEjeSchema.safeParse({
        eje,
        estado: 'no_verificable',
        motivo: 'emisor_no_publica_total',
      }).success,
    ).toBe(true);
    // Sin motivo, `no_verificable` vuelve a ser la salida de emergencia que en tres sprints usan todos.
    expect(resultadoDeEjeSchema.safeParse({ eje, estado: 'no_verificable' }).success).toBe(false);
    // Y un motivo pegado a un estado que sí se verificó es igual de incoherente.
    expect(
      resultadoDeEjeSchema.safeParse({
        eje,
        estado: 'cuadra',
        motivo: 'emisor_no_publica_total',
      }).success,
    ).toBe(false);
  });
});

describe('catálogo de conceptos — evidencia sin dato de cliente', () => {
  it('todo concepto de la unión tiene definición, y ninguna definición sobra', () => {
    expect(Object.keys(CATALOGO_DE_CONCEPTOS).sort()).toEqual([...TIPOS_CONCEPTO_LIQUIDACION].sort());
  });

  it('la procedencia cita un documento trackeado y los formatos donde se midió, nunca un conteo', () => {
    for (const definicion of Object.values(CATALOGO_DE_CONCEPTOS)) {
      expect(definicion.procedencia.documento.startsWith('docs/')).toBe(true);
      expect(definicion.procedencia.formatos.length).toBeGreaterThan(0);
      // El shape del catálogo canónico lleva `movimientos: number`; acá ese conteo sería una medición
      // del volumen de actividad comercial de un cliente identificable (N2). El tipo no lo tiene, y este
      // test lo deja verificado en vez de confiado.
      expect(Object.keys(definicion.procedencia)).not.toContain('movimientos');
    }
  });
});
