/**
 * Adapter Visa débito contra el DOCUMENTO REAL — commit 2 del plan 14 (plan 15, OCR), 2026-08-19.
 *
 * `it.skipIf(!existsSync(...))`: mismo criterio dual estricto/CI que ya usa `tools/barrido-fuga.ts` —
 * el fixture real vive en `privado/` (gitignored) y nunca llega a CI ni a otra máquina. En una sesión
 * sin el archivo, este test se salta (no falla) y el resto de la suite sigue verde; en la máquina que sí
 * lo tiene, corre el pipeline completo de verdad. JP lo pidió documentado explícito acá.
 *
 * Aserciones ESTRUCTURALES solamente (conteos, `.success`, distribución de estados) — **nunca** un valor
 * literal real del documento. Ni siquiera en un `toBe` de un string: eso es exactamente el hallazgo H-A
 * que ya corrigió `parseo-ar.ts`.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extraerConOcrSiHaceFalta } from '../src/ocr.ts';
import { hashArchivo } from '../src/hash.ts';
import { extraerTexto } from '../src/texto-pdf.ts';
import {
  leerVisaDebito,
  reconoceVisaDebito,
  CAPACIDADES_VISA_DEBITO,
  FORMATO_CODIGO,
  VERSION,
} from '../src/liquidaciones/formatos/visa-debito.ts';
import { liquidacionProcesadaSchema } from '../src/liquidaciones/esquema.ts';
import { verificarAritmeticaPorLiquidacion } from '../src/liquidaciones/verificacion.ts';
import type { EntradaDeLiquidacion } from '../src/liquidaciones/registro.ts';

const RUTA_FIXTURE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'privado',
  'tarjetas',
  '01-extracto_visa_debito_roka.pdf',
);
const TIENE_FIXTURE = existsSync(RUTA_FIXTURE);

describe.skipIf(!TIENE_FIXTURE)('adapter Visa débito contra el documento real', () => {
  it(
    'procesa las 8 páginas escaneadas, reconoce el formato y arma liquidaciones válidas contra el esquema',
    async () => {
      const contenido = new Uint8Array(await readFile(RUTA_FIXTURE));

      const [{ paginas, usoOcrEnPagina, pixelesDePagina }, texto] = await Promise.all([
        extraerConOcrSiHaceFalta(contenido),
        extraerTexto(contenido),
      ]);

      // Confirma la premisa que motivó todo el plan 15: el documento es enteramente escaneado.
      expect(texto.requiereOcr).toBe(true);
      expect(usoOcrEnPagina.every((u) => u === true)).toBe(true);

      const entrada: EntradaDeLiquidacion = { paginas, usoOcrEnPagina, pixelesDePagina };

      expect(reconoceVisaDebito(entrada)).toBe(true);

      const salida = await leerVisaDebito(entrada);

      // Al menos una liquidación reconocida — el documento trae varias por página. Desde el plan 16
      // paso 3 (reintento sobre recorte para `neto_acreditado`) este conteo puede ser mayor que antes,
      // pero sigue sin fijarse como cifra puntual: HANDOFF 83 documentó que la cobertura de OCR sobre
      // este mismo documento varió entre lanzamientos del proceso (7/14 y 9/12 filas, causa no
      // identificada) — medido en esta sesión (2026-08-20), puede variar entre lanzamientos.
      expect(salida.liquidaciones.length).toBeGreaterThan(0);

      const procesada = liquidacionProcesadaSchema.safeParse({
        formatoCodigo: FORMATO_CODIGO,
        adaptadorVersion: VERSION,
        capacidades: CAPACIDADES_VISA_DEBITO,
        archivoHash: hashArchivo(contenido),
        paginas: texto.paginas.length,
        paginasSinTexto: texto.paginasSinTexto,
        liquidaciones: salida.liquidaciones,
        totalConsolidadoDeclarado:
          salida.totalConsolidadoDeclarado === undefined
            ? { estado: 'no_publicado' }
            : { estado: 'publicado', valor: salida.totalConsolidadoDeclarado },
        lineasNoInterpretadas: salida.lineasNoInterpretadas,
      });
      expect(procesada.success, procesada.success ? '' : JSON.stringify(procesada.error.issues)).toBe(
        true,
      );

      // El eje 2 (checksum del emisor) necesita el total consolidado: la capacidad lo declara true.
      expect(salida.totalConsolidadoDeclarado).toBeDefined();

      // Eje 1, agregado por estado — nunca el detalle de una liquidación puntual.
      const eje1 = salida.liquidaciones.map((l) => verificarAritmeticaPorLiquidacion(l));
      const porEstado = { cuadra: 0, no_cuadra: 0, no_verificable: 0 };
      for (const r of eje1) porEstado[r.estado] += 1;
      expect(porEstado.cuadra + porEstado.no_cuadra + porEstado.no_verificable).toBe(eje1.length);

      // Eje 4, agregado — nunca un valorLeido.
      expect(salida.confianzaDeCaptura).toBeDefined();
      if (salida.confianzaDeCaptura) {
        const porEstadoConfianza = { confiable: 0, dudoso: 0, no_evaluable: 0 };
        for (const c of salida.confianzaDeCaptura) porEstadoConfianza[c.estado] += 1;
        expect(
          porEstadoConfianza.confiable + porEstadoConfianza.dudoso + porEstadoConfianza.no_evaluable,
        ).toBe(salida.confianzaDeCaptura.length);
      }

      // Ninguna línea no interpretada puede contener un dato real: la forma es una máscara, se verifica
      // que efectivamente lo sea (nunca dígitos crudos del documento).
      for (const linea of salida.lineasNoInterpretadas) {
        expect(/\d{3,}/.test(linea.forma)).toBe(false);
      }
    },
    // OCR real sobre 8 páginas (~90s medido) + hasta 14 reintentos reales de `reconocerRecorte` (plan
    // 16 paso 3, uno por fila de `neto_acreditado` que falle en la primera lectura). Margen generoso.
    360_000,
  );
});
