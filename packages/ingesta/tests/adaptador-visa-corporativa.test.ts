/**
 * Adapter Visa corporativa contra los 3 DOCUMENTOS REALES (Bracci Repuestos S.A.S., piloto,
 * mayo/junio/julio 2026). Mismo criterio que `liquidaciones-visa-credito.test.ts`:
 * `describe.skipIf(!existsSync(...))`, el fixture real vive en `privado/` (gitignored) y nunca llega
 * a CI ni a otra máquina. Aserciones ESTRUCTURALES solamente (conteos, `.success` de schema,
 * distribución de estados) — NUNCA un valor literal real del documento.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashArchivo } from '../src/hash.ts';
import { aFilas, extraerTexto } from '../src/texto-pdf.ts';
import {
  adaptadorVisaCorporativa,
  BANCO_CODIGO,
  CAPACIDADES_VISA_CORPORATIVA,
  leerVisaCorporativa,
  reconoceVisaCorporativa,
  VERSION,
} from '../src/adaptadores/visa-corporativa.ts';
import { extractoParseadoSchema } from '../src/esquema.ts';

const CARPETA_FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'privado',
  'piloto_capa_d',
  'Bracci',
  'Tarjeta corporativa',
);

const MESES = [
  { etiqueta: 'mayo 2026', archivo: '05-2026-Tarjeta-Corporativa.pdf' },
  { etiqueta: 'junio 2026', archivo: '06-2026-Tarjeta-Corporativa.pdf' },
  { etiqueta: 'julio 2026', archivo: '07.2026-Tarjeta-Corporativa.pdf' },
] as const;

for (const { etiqueta, archivo } of MESES) {
  const ruta = join(CARPETA_FIXTURES, archivo);
  const tieneFixture = existsSync(ruta);

  describe.skipIf(!tieneFixture)(`adapter Visa corporativa contra el documento real — ${etiqueta}`, () => {
    it('reconoce el documento, arma DOS cuentas (una por moneda) válidas contra el esquema y captura movimientos', async () => {
      const contenido = new Uint8Array(await readFile(ruta));

      const [texto, filas] = await Promise.all([extraerTexto(contenido), aFilas(contenido)]);

      // Página 6 es imagen (bug de OCR ya documentado, ajeno a esta tarea): el contrato de este
      // adaptador nunca la toca — solo recibe `filas` de texto nativo (páginas 1-5).
      expect(texto.paginasSinTexto.length).toBeGreaterThan(0);

      expect(reconoceVisaCorporativa(filas)).toBe(true);
      expect(adaptadorVisaCorporativa.reconoce({ filas })).toBe(true);

      const salida = leerVisaCorporativa(filas);

      // Regla 4 del contrato: siempre una lista, nunca "la cuenta" pelada. `multiCuenta: true`: la
      // misma tarjeta física es DOS posiciones, una por moneda (V12: `cuenta_bancaria.moneda` es
      // `char(3) not null`, nunca ARS y USD mezclados en una cuenta) — acá se esperan exactamente 2,
      // SIEMPRE, aunque una de las dos haya dado 0 movimientos ese mes (no se omite la cuenta).
      expect(salida.cuentas.length).toBe(2);

      const cuentaArs = salida.cuentas.find((c) => c.cuenta.moneda === 'ARS');
      const cuentaUsd = salida.cuentas.find((c) => c.cuenta.moneda === 'USD');
      expect(cuentaArs).toBeDefined();
      expect(cuentaUsd).toBeDefined();
      if (!cuentaArs || !cuentaUsd) return;

      for (const cuenta of [cuentaArs, cuentaUsd]) {
        expect(cuenta.cuenta.tipoCuenta).toBe('tarjeta_corporativa');
        // Toda cuenta trae exclusivamente movimientos DE SU PROPIA moneda — nunca mezclados.
        expect(cuenta.movimientos.every((m) => m.moneda === cuenta.cuenta.moneda)).toBe(true);
        // `filaNumero` es el índice DENTRO DE ESTA cuenta: 1-based y sin huecos.
        expect(cuenta.movimientos.map((m) => m.filaNumero)).toEqual(
          cuenta.movimientos.map((_, i) => i + 1),
        );
      }

      const totalMovimientos = cuentaArs.movimientos.length + cuentaUsd.movimientos.length;
      expect(totalMovimientos).toBeGreaterThan(0);

      // Regla 3 del contrato: toda línea no interpretada trae su forma, nunca su texto — se verifica
      // que la forma sea efectivamente una máscara. Igual criterio que `liquidaciones-visa-
      // credito.test.ts`: corrida de 3+ dígitos, no "ningún dígito" — `formaParaLog` colapsa una
      // corrida larga a `X{n}` y ese `n` (una longitud, no un dato) sí puede tener 1-2 dígitos.
      for (const linea of salida.lineasNoInterpretadas) {
        expect(/\d{3,}/.test(linea.forma)).toBe(false);
      }

      // Esquema completo, como lo vería el registro.
      const parseado = extractoParseadoSchema.safeParse({
        bancoCodigo: BANCO_CODIGO,
        adaptadorVersion: VERSION,
        capacidades: CAPACIDADES_VISA_CORPORATIVA,
        archivoHash: hashArchivo(contenido),
        paginas: texto.paginas.length,
        paginasSinTexto: [...texto.paginasSinTexto],
        cuentas: salida.cuentas,
        lineasNoInterpretadas: salida.lineasNoInterpretadas,
      });
      expect(parseado.success, parseado.success ? '' : JSON.stringify(parseado.error.issues)).toBe(true);

      // Hashes únicos EN EL LOTE (entre las dos cuentas, no solo dentro de cada una): dedupe de
      // idempotencia (ADR-0001 §5.1) — mismo control que `probar-adaptador.ts` corre sobre el lote
      // real. La `moneda` entra en la `ClaveCuenta` (ver `armarCuenta`), así que dos movimientos
      // idénticos en ARS y en USD nunca deberían colisionar.
      const todosLosMovimientos = [...cuentaArs.movimientos, ...cuentaUsd.movimientos];
      const hashes = new Set(todosLosMovimientos.map((m) => m.filaHash));
      expect(hashes.size).toBe(todosLosMovimientos.length);

      // Distribución por columna — nunca un valor puntual, solo que la partición cierre.
      const porColumna = { credito: 0, debito: 0 };
      for (const m of todosLosMovimientos) {
        if (m.credito !== undefined) porColumna.credito += 1;
        if (m.debito !== undefined) porColumna.debito += 1;
      }
      expect(porColumna.credito + porColumna.debito).toBe(todosLosMovimientos.length);

      // Toda referencia capturada es un código de comprobante de 6 dígitos — nunca vacía.
      for (const m of todosLosMovimientos) {
        for (const r of m.referencias ?? []) {
          expect(r.tipo).toBe('operacion');
          expect(/^\d{6}$/.test(r.valor)).toBe(true);
        }
      }

      // El conteo real (por cuenta) se reporta fuera de este test, junto con el resto de los
      // hallazgos — no se afirma acá si cumple o no la predicción de la tarea.
    });

    it('no reconoce el documento como ningún otro banco del roster (vocabulario disjunto)', async () => {
      const contenido = new Uint8Array(await readFile(ruta));
      const filas = await aFilas(contenido);

      // Import dinámico: evita que un fallo de import de otro adaptador tumbe este archivo si algún
      // día alguno cambia de forma. Se prueban los 6 bancos y Visa corporativa contra el MISMO
      // documento — ninguno de los bancarios tiene que reconocerlo.
      const [{ reconoceGalicia }, { reconoceSantander }, { reconoceMacro }, { reconoceBancor }, { reconoceNacion }, { reconoceICBC }] =
        await Promise.all([
          import('../src/adaptadores/galicia.ts'),
          import('../src/adaptadores/santander.ts'),
          import('../src/adaptadores/macro.ts'),
          import('../src/adaptadores/bancor.ts'),
          import('../src/adaptadores/nacion.ts'),
          import('../src/adaptadores/icbc.ts'),
        ]);

      expect(reconoceGalicia(filas)).toBe(false);
      expect(reconoceSantander(filas)).toBe(false);
      expect(reconoceMacro(filas)).toBe(false);
      expect(reconoceBancor(filas)).toBe(false);
      expect(reconoceNacion(filas)).toBe(false);
      expect(reconoceICBC(filas)).toBe(false);
    });
  });
}
