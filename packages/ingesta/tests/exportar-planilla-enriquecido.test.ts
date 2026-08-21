/**
 * Enriquecimiento del export (capa B + capa C, en memoria) — `exportarPlanillaDeLote` contra base
 * real. Plan "export enriquecido" (2026-08-21).
 *
 * Bloque E: identificación correcta contra los TRES bancos del corpus, gateo por destinatario
 * (dictamen bloqueante de `seguridad-datos-financieros` + `security-engineer`: capa C solo para
 * `estudio_interno`), y el mutation test real de que `pendienteDeLaura` nunca sale a la columna 2.
 *
 * Vocabulario: literales del FORMATO de cada banco (ya citados en `catalogo.ts`/`corpus-*.test.ts`),
 * nunca un dato de cliente — mismo criterio que el resto del repo. Se generan con `extractoSintetico`
 * (cadena de saldos e hash válidos) y se sobreescribe SOLO `conceptoBanco`/`conceptoCompleto`/
 * `conceptoBancoEstrategia` de movimientos puntuales — esos tres campos no entran en `filaHash`
 * (`hashFila`: cuenta/fecha/importe/saldo/descripcion/ordinal), así que la cadena sigue cuadrando.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { altaDeSocio, conUsuario, cerrarConexiones, escribirConAuditoria } from '@sistema-contable/data';
import {
  CAPACIDADES_SINTETICAS,
  exportarPlanillaDeLote,
  extractoSintetico,
  persistirCuenta,
  verificarAritmetica,
  type CuentaConMovimientos,
  type EstadoLotePersistido,
} from '@sistema-contable/ingesta';
import { digestDeBanco, lexicoDe } from '@sistema-contable/contabilidad';
import { hmacDocumento, pepperIdActual } from '@sistema-contable/shared/seguridad';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../data/tests/ayuda.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

async function registrarBanco(codigo: string): Promise<void> {
  const duenio = await clienteDuenio();
  try {
    await duenio.query(`insert into banco (codigo, nombre) values ($1, $2) on conflict (codigo) do nothing`, [
      codigo,
      codigo.toUpperCase(),
    ]);
  } finally {
    await duenio.end();
  }
}

async function registrarCuenta(clienteId: string, bancoCodigo: string): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const c = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias) values ($1, $2, 'ARS', $3)
       returning id::text as id`,
      [clienteId, bancoCodigo, `Cuenta ${bancoCodigo}`],
    );
    const id = c[0]?.id;
    if (!id) throw new Error('no se creó la cuenta de prueba');
    return id;
  });
}

/** Fuerza el `conceptoBanco` de los primeros N movimientos de cada `columnaOrigen` pedido — sin tocar
 *  importe/saldo/descripción/hash. `literalDebito`/`literalCredito` en `undefined` deja ese lado sin
 *  tocar (queda el texto sintético genérico, que cae en `sin_reconocer`/`concepto_no_catalogado`). */
function conConceptosForzados(
  cuenta: CuentaConMovimientos,
  asignaciones: readonly { readonly columnaOrigen: 'debito' | 'credito'; readonly literal: string }[],
): CuentaConMovimientos {
  const restante = [...asignaciones];
  const movimientos = cuenta.movimientos.map((m) => {
    if (m.tipoFila !== 'movimiento') return m;
    const i = restante.findIndex((a) => a.columnaOrigen === m.columnaOrigen);
    if (i === -1) return m;
    const asignacion = restante[i];
    restante.splice(i, 1);
    if (!asignacion) return m;
    // `persistirCuenta` exige `descripcion.startsWith(conceptoBanco)` (INV-14, `persistir.ts`) — se
    // reescribe `descripcion`/`descripcionLineas` para que el literal forzado siga siendo su prefijo,
    // en vez de dejar la descripción sintética original (que no lo era).
    const descripcion = `${asignacion.literal} ${m.descripcion}`;
    return {
      ...m,
      conceptoBanco: asignacion.literal,
      conceptoCompleto: true,
      conceptoBancoEstrategia: 'segmento_de_glosa' as const,
      descripcion,
      descripcionLineas: [asignacion.literal, ...m.descripcionLineas],
    };
  });
  if (restante.length > 0) {
    throw new Error(
      `fixture inválido: no había suficientes movimientos de columnaOrigen para asignar ${JSON.stringify(restante)}`,
    );
  }
  return { ...cuenta, movimientos };
}

async function crearLotePersistido(opciones: {
  readonly clienteId: string;
  readonly bancoCodigo: string;
  readonly cuenta: CuentaConMovimientos;
  readonly cuentaBancariaId: string;
}): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const creado = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, procesado_por)
       values ($1, $2, $3, 'archivo', $4, 'recibido', app.current_user_id())
       returning id::text as id`,
      [opciones.clienteId, opciones.bancoCodigo, `${opciones.bancoCodigo}@1`, randomUUID()],
    );
    const loteId = creado[0]?.id;
    if (!loteId) throw new Error('no se creó el lote de prueba');

    const movimientosEnElLote = opciones.cuenta.movimientos.length;
    const verificacion = verificarAritmetica(opciones.cuenta, {
      capacidades: CAPACIDADES_SINTETICAS as never,
      movimientosEnElLote,
    });
    const persistido = await persistirCuenta(tx, {
      clienteId: opciones.clienteId,
      loteId,
      cuentaBancariaId: opciones.cuentaBancariaId,
      cuenta: opciones.cuenta,
      verificacion,
      movimientosEnElLote,
    });
    if (!persistido.persistido) {
      throw new Error(`fixture inválido: la cuenta debía persistir y no lo hizo (${persistido.motivoCodigo})`);
    }
    const estado: EstadoLotePersistido = persistido.estado;

    await tx.consultar(`update lote_ingesta set estado = $2, filas_leidas = $3, filas_aceptadas = $3 where id = $1`, [
      loteId,
      estado,
      movimientosEnElLote,
    ]);

    return loteId;
  });
}

/** El id del movimiento con ESE `conceptoBanco`, dentro del lote — para poder colgarle un candidato
 *  de contraparte después de persistir (la API de `persistirCuenta` no devuelve ids por fila). */
async function buscarMovimientoIdPorConcepto(clienteId: string, loteId: string, conceptoBanco: string): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const filas = await tx.consultar<{ id: string }>(
      `select id::text as id from movimiento_bancario_crudo
        where cliente_id = $1 and lote_ingesta_id = $2 and concepto_banco = $3
        limit 1`,
      [clienteId, loteId, conceptoBanco],
    );
    const id = filas[0]?.id;
    if (!id) throw new Error(`fixture inválido: no se encontró un movimiento con concepto_banco=${conceptoBanco}`);
    return id;
  });
}

/** Alta de un socio del padrón — mismo camino que `apps/cli/src/alta-socio.ts` (no se puede importar
 *  desde `apps/cli` acá: `packages/ingesta` no depende de `apps/`), reconstruido con las piezas de
 *  `@sistema-contable/data` que ese CLI ya usa por debajo. */
async function altaDeSocioDePrueba(args: {
  readonly clienteId: string;
  readonly usuarioId: string;
  readonly documento: string;
}): Promise<string> {
  return conUsuario(args.usuarioId, (tx) =>
    escribirConAuditoria(
      tx,
      { clienteId: args.clienteId, accion: 'escritura', recurso: 'padron_socio', motivo: 'alta de prueba' },
      async (ctx) => {
        const r = await altaDeSocio(tx, ctx, {
          clienteId: args.clienteId,
          denominacion: 'SOCIO DE PRUEBA SRL',
          documentoTipo: 'cuit',
          documento: args.documento,
          vigenteDesde: '2026-01-01',
        });
        return r.socioId;
      },
    ),
  );
}

/** Cuelga un candidato de contraparte (mismo HMAC/pepper que produciría la captura real) de un
 *  movimiento ya persistido — mismo patrón que `apps/cli/tests/resolver-contrapartida.test.ts`. */
async function agregarCandidato(args: {
  readonly clienteId: string;
  readonly movimientoId: string;
  readonly documento: string;
}): Promise<void> {
  const hmac = hmacDocumento('cuit', args.documento, args.clienteId);
  await conUsuario(USUARIOS.socio, (tx) =>
    tx.consultar(
      `insert into movimiento_contraparte_identificador (cliente_id, movimiento_id, clase, identificador_hmac, pepper_id)
       values ($1, $2, 'cuit', $3, $4)`,
      [args.clienteId, args.movimientoId, hmac, pepperIdActual()],
    ),
  );
}

/** Todas las cadenas imprimibles de un `.xlsx` — string suelto + cada entrada ZIP inflada. Mismo
 *  camino que `exportar-planilla.test.ts` (reimplementado acá por la misma razón: opera sobre un
 *  buffer en memoria, y la función original no está exportada). */
function cadenasDelXlsx(buffer: Uint8Array): string {
  const buf = Buffer.from(buffer);
  const partes: string[] = [buf.toString('latin1')];
  for (let i = 0; i < buf.length - 30; i += 1) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const nombreLargo = buf.readUInt16LE(i + 26);
    const extraLargo = buf.readUInt16LE(i + 28);
    const inicio = i + 30 + nombreLargo + extraLargo;
    try {
      // 'utf8', no 'latin1': el XML de ExcelJS declara UTF-8 y el texto humano lleva tildes/em-dash —
      // decodificar como latin1 los mojibakea (verificado: "versión" salía "versiÃ³n").
      partes.push(inflateRawSync(buf.subarray(inicio), { finishFlush: 2 }).toString('utf8'));
    } catch {
      /* entrada sin comprimir o corrupta: ya cubierta por el string crudo de arriba */
    }
  }
  return partes.join('\n');
}

describe('exportarPlanillaDeLote — enriquecimiento (capa B + capa C), Galicia', () => {
  it('estudio_interno: identifica las 4 clases reales, y NUNCA expone la pregunta de pendienteDeLaura', async () => {
    await registrarBanco('galicia');
    const cuentaBancariaId = await registrarCuenta(s.clienteA, 'galicia');
    const base = extractoSintetico({
      semilla: 9101,
      cantidadMovimientos: 20,
      saldoInicialCentavos: 200_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'galicia',
    });
    const cuenta = conConceptosForzados(base, [
      // propuesta — comisión bancaria, resuelve directo (catalogo.ts: comision_de_transferencia).
      { columnaOrigen: 'debito', literal: 'COM. GESTION TRANSF.FDOS' },
      // decision_humana / completar_con_liquidacion_del_adquirente — identidad resuelta, falta Capa D.
      { columnaOrigen: 'credito', literal: 'ACREDITAMIENTO' },
      // decision_humana / confirmar_hipotesis_del_lexico — tiene pendienteDeLaura con una pregunta
      // ESPECÍFICA (catalogo.ts, transferencia_cash_management) que la columna 2 NUNCA debe repetir.
      { columnaOrigen: 'debito', literal: 'TRANSFERENCIAS CASH' },
      // sin_reconocer / concepto_no_catalogado — no matchea ningún literal del léxico de Galicia.
      { columnaOrigen: 'credito', literal: 'ZZZ CONCEPTO INVENTADO PARA EL TEST ZZZ' },
    ]);

    const loteId = await crearLotePersistido({ clienteId: s.clienteA, bancoCodigo: 'galicia', cuenta, cuentaBancariaId });

    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId,
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'estudio_interno',
        generadoEn: '2026-08-21T00:00:00.000Z',
      }),
    );
    expect(r.estado).toBe('armada');
    if (r.estado !== 'armada') return;

    const texto = cadenasDelXlsx(r.libro);

    // propuesta: identidad resuelta, "Qué falta" vacía.
    expect(texto).toContain('Comisión bancaria');

    // decision_humana / completar_con_liquidacion_del_adquirente: identidad + el motivo ratificado.
    expect(texto).toContain('Acreditación de tarjeta (cobro con tarjeta)');
    expect(texto).toContain('falta la liquidación de la tarjeta/adquirente');

    // decision_humana / confirmar_hipotesis_del_lexico: el texto GENÉRICO sí aparece...
    expect(texto).toContain('El sistema tiene una hipótesis sobre qué es este movimiento');
    // ...pero la pregunta interna específica de este literal (pendienteDeLaura.pregunta) NUNCA.
    // Mutation test real: si `textoDeQueDecide` usara `entrada.pendienteDeLaura.pregunta` en vez del
    // texto genérico (la alternativa que `contador-dominio` propuso y `seguridad-datos-financieros`
    // bloqueó), esta aserción pasaría a roja.
    expect(texto).not.toContain('TRANSFERENCIAS CASH (8 mov.');
    expect(texto).not.toContain('el canal se usa también para cobranzas');

    // sin_reconocer: "Indeterminado" + motivo de concepto no catalogado.
    expect(texto).toContain('Indeterminado');
    expect(texto).toContain('es un concepto nuevo, no está en el vocabulario cargado');

    // Sello de reproducibilidad — versión real del motor para Galicia, no un placeholder.
    const lexicoGalicia = lexicoDe('galicia');
    if (!lexicoGalicia) throw new Error('fixture inválido: no hay léxico registrado para galicia');
    const digestReal = digestDeBanco(lexicoGalicia);
    expect(texto).toContain(`Motor de reconocimiento — versión ${digestReal}`);
  });

  it.each(['cliente_titular', 'organismo'] as const)(
    'destinatario=%s: NUNCA corre capa C — columnas nuevas ausentes, sello dice "no se ejecutó"',
    async (destinatarioCodigo) => {
      await registrarBanco('galicia');
      const cuentaBancariaId = await registrarCuenta(s.clienteA, 'galicia');
      const base = extractoSintetico({
        semilla: 9102 + (destinatarioCodigo === 'organismo' ? 1 : 0),
        cantidadMovimientos: 6,
        saldoInicialCentavos: 50_000_00n,
        periodoDesde: '2026-06-01',
        periodoHasta: '2026-06-30',
        bancoCodigo: 'galicia',
      });
      // Mismo literal societario-sensible que dispararía "Retiro de socio (según padrón)" si capa C
      // corriera — acá el punto es que NO corra, así que ni siquiera hace falta padrón cargado.
      const cuenta = conConceptosForzados(base, [{ columnaOrigen: 'debito', literal: 'ACREDITAMIENTO' }]);

      const loteId = await crearLotePersistido({ clienteId: s.clienteA, bancoCodigo: 'galicia', cuenta, cuentaBancariaId });

      const r = await conUsuario(USUARIOS.contadorA, (tx) =>
        exportarPlanillaDeLote(tx, {
          clienteId: s.clienteA,
          loteId,
          motivoCodigo: 'demo_contadora',
          destinatarioCodigo,
          generadoEn: '2026-08-21T00:00:00.000Z',
        }),
      );
      expect(r.estado).toBe('armada');
      if (r.estado !== 'armada') return;

      const texto = cadenasDelXlsx(r.libro);
      expect(texto).not.toContain('Acreditación de tarjeta');
      expect(texto).not.toContain('falta la liquidación de la tarjeta/adquirente');
      expect(texto).toContain('Motor de reconocimiento — no se ejecutó');
      expect(texto).toContain('el destinatario de este export no recibe la propuesta del sistema');
    },
  );

  // 🔴 La ruta que el dictamen bloqueante de `seguridad-datos-financieros` + `security-engineer`
  // identificó como el riesgo real (capa C promoviendo a `retiro_de_socio`/`aporte_de_socio`) NO
  // tenía cobertura de punta a punta — hallazgo de `tester` sobre la primera versión de este archivo:
  // `conConceptosForzados` nunca corre capa C de verdad (ningún movimiento sintético trae un
  // identificador que matchee contra el padrón). Agregado con un candidato real en
  // `movimiento_contraparte_identificador`, es exactamente el mismo camino que
  // `apps/cli/tests/resolver-contrapartida.test.ts` ya prueba para el motor — acá se prueba que el
  // EXPORT lo muestra, con el calificador "(según padrón)" y solo para `estudio_interno`.
  it('capa C real: un candidato que matchea el padrón promueve a "Retiro de socio (según padrón)" — y NUNCA sale para cliente_titular', async () => {
    await registrarBanco('galicia');
    const cuentaBancariaId = await registrarCuenta(s.clienteA, 'galicia');
    const documento = '20999900099';
    await altaDeSocioDePrueba({ clienteId: s.clienteA, usuarioId: USUARIOS.socio, documento });

    const base = extractoSintetico({
      semilla: 9103,
      cantidadMovimientos: 6,
      saldoInicialCentavos: 80_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'galicia',
    });
    // 'TRANSFERENCIA A TERCEROS' (Galicia): decision_humana / distinguir_tercero_de_socio, lado debe
    // (catalogo.ts) — el candidato matcheado promueve a `retiro_de_socio` (motor.ts: lado==='debe').
    const cuenta = conConceptosForzados(base, [{ columnaOrigen: 'debito', literal: 'TRANSFERENCIA A TERCEROS' }]);
    const loteId = await crearLotePersistido({ clienteId: s.clienteA, bancoCodigo: 'galicia', cuenta, cuentaBancariaId });
    const movimientoId = await buscarMovimientoIdPorConcepto(s.clienteA, loteId, 'TRANSFERENCIA A TERCEROS');
    await agregarCandidato({ clienteId: s.clienteA, movimientoId, documento });

    const rInterno = await conUsuario(USUARIOS.contadorA, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId,
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'estudio_interno',
        generadoEn: '2026-08-21T00:00:00.000Z',
      }),
    );
    expect(rInterno.estado).toBe('armada');
    if (rInterno.estado !== 'armada') return;
    const textoInterno = cadenasDelXlsx(rInterno.libro);
    expect(textoInterno).toContain('Retiro de socio (según padrón)');
    // "Qué falta" tiene que quedar vacía: es clase `propuesta`, no hay nada pendiente de decidir.
    expect(textoInterno).not.toContain('Depende del padrón de socios');

    const rExterno = await conUsuario(USUARIOS.contadorA, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId,
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'cliente_titular',
        generadoEn: '2026-08-21T00:00:01.000Z',
      }),
    );
    expect(rExterno.estado).toBe('armada');
    if (rExterno.estado !== 'armada') return;
    const textoExterno = cadenasDelXlsx(rExterno.libro);
    // La leyenda estática ("Qué falta... confirmar si es un socio o un tercero") menciona "socio" —
    // eso es instrucción general, no un dato de ESTE movimiento. Lo que no puede aparecer es la
    // etiqueta que capa C produciría para esta fila puntual.
    expect(textoExterno).not.toContain('Retiro de socio');
    expect(textoExterno).not.toContain('Aporte de socio');
    expect(textoExterno).toContain('Motor de reconocimiento — no se ejecutó');
  });
});

describe('exportarPlanillaDeLote — enriquecimiento contra los tres bancos del corpus', () => {
  it.each(['santander', 'macro'] as const)('%s: enriquece y sella con el digest real del banco', async (bancoCodigo) => {
    const lexico = lexicoDe(bancoCodigo);
    if (!lexico) throw new Error(`fixture inválido: no hay léxico registrado para ${bancoCodigo}`);
    await registrarBanco(bancoCodigo);
    const cuentaBancariaId = await registrarCuenta(s.clienteA, bancoCodigo);
    const base = extractoSintetico({
      semilla: bancoCodigo === 'santander' ? 9201 : 9202,
      cantidadMovimientos: 6,
      saldoInicialCentavos: 60_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo,
    });
    const loteId = await crearLotePersistido({ clienteId: s.clienteA, bancoCodigo, cuenta: base, cuentaBancariaId });

    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId,
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'estudio_interno',
        generadoEn: '2026-08-21T00:00:00.000Z',
      }),
    );
    expect(r.estado).toBe('armada');
    if (r.estado !== 'armada') return;

    const texto = cadenasDelXlsx(r.libro);
    // Sin literales forzados, todo cae en sin_reconocer — igual verifica que el motor CORRIÓ (sello
    // con el digest real del banco) y que "Indeterminado" aparece — nunca un hueco.
    expect(texto).toContain(`Motor de reconocimiento — versión ${digestDeBanco(lexico)}`);
    expect(texto).toContain('Indeterminado');
  });
});
