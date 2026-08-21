/**
 * Adapter Cabal débito contra el DOCUMENTO REAL — plan 14, tercer formato.
 *
 * `it.skipIf(!existsSync(...))`: mismo criterio dual estricto/CI que los dos Visa — el fixture real vive
 * en `privado/` (gitignored) y nunca llega a CI ni a otra máquina.
 *
 * Aserciones ESTRUCTURALES solamente (conteos, `.success`, distribución de estados) — **nunca** un valor
 * literal real del documento. Mismo criterio que `liquidaciones-visa-debito.test.ts:9-11`.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extraerConOcrSiHaceFalta } from '../src/ocr.ts';
import { hashArchivo } from '../src/hash.ts';
import { extraerTexto } from '../src/texto-pdf.ts';
import {
  leerCabalDebito,
  reconoceCabalDebito,
  CAPACIDADES_CABAL_DEBITO,
  FORMATO_CODIGO,
  VERSION,
} from '../src/liquidaciones/formatos/cabal-debito.ts';
import { liquidacionProcesadaSchema } from '../src/liquidaciones/esquema.ts';
import { verificarAritmeticaPorLiquidacion, verificarEjeChecksumDelEmisor } from '../src/liquidaciones/verificacion.ts';
import type { EntradaDeLiquidacion } from '../src/liquidaciones/registro.ts';

const RUTA_FIXTURE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'privado',
  'tarjetas',
  '03-extracto_cabal_liquidacion_roka.pdf',
);
const TIENE_FIXTURE = existsSync(RUTA_FIXTURE);

describe.skipIf(!TIENE_FIXTURE)('adapter Cabal débito contra el documento real', () => {
  it(
    'procesa las páginas escaneadas, reconoce el formato y arma liquidaciones válidas contra el esquema',
    async () => {
      const contenido = new Uint8Array(await readFile(RUTA_FIXTURE));

      const [{ paginas, usoOcrEnPagina, pixelesDePagina }, texto] = await Promise.all([
        extraerConOcrSiHaceFalta(contenido),
        extraerTexto(contenido),
      ]);

      // Confirma la premisa medida en HANDOFF 89: el documento es enteramente escaneado.
      expect(texto.requiereOcr).toBe(true);
      expect(usoOcrEnPagina.every((u) => u === true)).toBe(true);

      const entrada: EntradaDeLiquidacion = { paginas, usoOcrEnPagina, pixelesDePagina };

      expect(reconoceCabalDebito(entrada)).toBe(true);

      const salida = await leerCabalDebito(entrada);

      // HANDOFF 89 confirmó 5 liquidaciones por conteo manual verificado aritméticamente, la 5ª sin
      // línea de cierre reconocible en OCR — esa 5ª cae en lineasNoInterpretadas, no en liquidaciones.
      // No se fija el número acá como cifra puntual (mismo criterio que ya adoptó
      // liquidaciones-visa-debito.test.ts): la cobertura de OCR puede variar entre lanzamientos.
      expect(salida.liquidaciones.length).toBeGreaterThan(0);

      const procesada = liquidacionProcesadaSchema.safeParse({
        formatoCodigo: FORMATO_CODIGO,
        adaptadorVersion: VERSION,
        capacidades: CAPACIDADES_CABAL_DEBITO,
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

      // Cabal no publica total consolidado: a diferencia de Visa débito, este adapter nunca lo expone.
      expect(salida.totalConsolidadoDeclarado).toBeUndefined();

      // Eje 1, agregado por estado — nunca el detalle de una liquidación puntual.
      const eje1 = salida.liquidaciones.map((l) => verificarAritmeticaPorLiquidacion(l));
      const porEstadoEje1 = { cuadra: 0, no_cuadra: 0, no_verificable: 0 };
      for (const r of eje1) porEstadoEje1[r.estado] += 1;
      expect(porEstadoEje1.cuadra + porEstadoEje1.no_cuadra + porEstadoEje1.no_verificable).toBe(
        eje1.length,
      );

      // Eje 2: capacidades.traeTotalDelEmisor es false, así que el caller SIEMPRE tiene que dar
      // no_verificable/emisor_no_publica_total para cada liquidación — nunca corre la comparación.
      for (const liquidacion of salida.liquidaciones) {
        const eje2 = verificarEjeChecksumDelEmisor(CAPACIDADES_CABAL_DEBITO, [liquidacion], '0.00');
        expect(eje2).toEqual({
          eje: 'checksum_del_emisor',
          estado: 'no_verificable',
          motivo: 'emisor_no_publica_total',
        });
      }

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

      // Ningún renglón de percepcion_iva_rg2408: capacidades.traePercepcionIva es false (HANDOFF 89,
      // confirmado que el concepto no aparece en ningún bloque real del documento).
      for (const liquidacion of salida.liquidaciones) {
        expect(liquidacion.renglones.some((r) => r.concepto === 'percepcion_iva_rg2408')).toBe(false);
      }
    },
    // OCR real, documento más corto que los dos Visa pero mismo pipeline. Margen generoso, igual criterio.
    360_000,
  );
});
