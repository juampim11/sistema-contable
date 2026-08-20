/**
 * Adapter Visa crédito contra el DOCUMENTO REAL — commit 2b del plan 14 (plan 15/16, OCR), 2026-08-20.
 *
 * Mismo criterio que `liquidaciones-visa-debito.test.ts`: `describe.skipIf(!existsSync(...))`, el
 * fixture real vive en `privado/` (gitignored) y nunca llega a CI ni a otra máquina. Aserciones
 * ESTRUCTURALES solamente (conteos, `.success`, distribución de estados) — **nunca** un valor literal
 * real del documento.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extraerConOcrSiHaceFalta } from '../src/ocr.ts';
import { hashArchivo } from '../src/hash.ts';
import { extraerTexto } from '../src/texto-pdf.ts';
import {
  leerVisaCredito,
  reconoceVisaCredito,
  CAPACIDADES_VISA_CREDITO,
  FORMATO_CODIGO,
  VERSION,
} from '../src/liquidaciones/formatos/visa-credito.ts';
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
  '02-extracto_visa_credito_roka.pdf',
);
const TIENE_FIXTURE = existsSync(RUTA_FIXTURE);

describe.skipIf(!TIENE_FIXTURE)('adapter Visa crédito contra el documento real', () => {
  it(
    'procesa las 9 páginas escaneadas, reconoce el formato y arma liquidaciones válidas contra el esquema',
    async () => {
      const contenido = new Uint8Array(await readFile(RUTA_FIXTURE));

      const [{ paginas, usoOcrEnPagina, pixelesDePagina }, texto] = await Promise.all([
        extraerConOcrSiHaceFalta(contenido),
        extraerTexto(contenido),
      ]);

      // Confirma la premisa del plan 15: el documento es enteramente escaneado, igual que débito.
      expect(texto.requiereOcr).toBe(true);
      expect(usoOcrEnPagina.every((u) => u === true)).toBe(true);

      const entrada: EntradaDeLiquidacion = { paginas, usoOcrEnPagina, pixelesDePagina };

      expect(reconoceVisaCredito(entrada)).toBe(true);

      const salida = await leerVisaCredito(entrada);

      // Al menos una liquidación reconocida — el documento trae varias por página. No se fija como
      // cifra puntual: el mismo documento OCR-eado dos veces puede variar entre lanzamientos del
      // proceso (mismo hallazgo que HANDOFF 83 documentó para débito).
      expect(salida.liquidaciones.length).toBeGreaterThan(0);

      const procesada = liquidacionProcesadaSchema.safeParse({
        formatoCodigo: FORMATO_CODIGO,
        adaptadorVersion: VERSION,
        capacidades: CAPACIDADES_VISA_CREDITO,
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

      // Eje 1, agregado por estado — nunca el detalle de una liquidación puntual. `no_verificable` es
      // un resultado legítimo acá: cualquier liquidación con `percepcion_iva_rg2408` de monto ≠ 0 cae
      // ahí (efecto `no_determinado` del catálogo), no es una falla del adapter.
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

      // NO se afirma "como máximo 2 renglones de percepción por liquidación" acá, a propósito: medido
      // en esta sesión, contra el documento real, un bloque puede traer más de 2 cuando el OCR no
      // reconoce la línea de cierre (`ES_LINEA_CIERRE`) de UNA liquidación real — sus renglones
      // quedan acumulados y se fusionan con los del siguiente cierre que sí se reconoce. Es la misma
      // limitación de cobertura parcial de OCR que ya documenta `visa-debito.ts` (no todas las
      // liquidaciones se interpretan), nunca invisible: el eje 1
      // (`verificarAritmeticaPorLiquidacion`) da `no_cuadra` sobre un bloque fusionado, porque la
      // suma de dos liquidaciones no reproduce el neto de una sola. El caso de DOS renglones exactos
      // —el medido y esperado por diseño— está cubierto por
      // `liquidaciones-visa-credito-percepcion.test.ts`, 100% sintético y sin esta variable de OCR.

      // Ninguna línea no interpretada puede contener un dato real: la forma es una máscara, se verifica
      // que efectivamente lo sea (nunca dígitos crudos del documento).
      for (const linea of salida.lineasNoInterpretadas) {
        expect(/\d{3,}/.test(linea.forma)).toBe(false);
      }
    },
    // OCR real sobre 9 páginas + hasta 30 reintentos reales de `reconocerRecorte` (uno por
    // `neto_acreditado` que falla en la primera lectura). Medido: 379s con el timeout original de
    // 360s (heredado de débito, 8 páginas) — insuficiente acá, más páginas y más bloques con
    // reintento disparado. 600s da margen sobre lo medido, con la misma salvedad de HANDOFF 83: la
    // duración de un pipeline con OCR real puede variar entre lanzamientos del proceso, no se toma
    // como cifra estable.
    600_000,
  );
});
