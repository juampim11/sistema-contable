/**
 * Entrypoint de un proceso hijo AISLADO: corre `reconocerImagen()` de verdad, contra una imagen
 * 100% sintética (un rectángulo blanco, sin texto ni dato de ningún cliente), y reporta el resultado
 * por stdout como JSON.
 *
 * Vive en un proceso propio (spawneado por `ocr.test.ts` vía `node:child_process`) porque la guardia de
 * red (`guardia-sin-red.mjs`) se instala con `NODE_OPTIONS`, y `NODE_OPTIONS` solo se procesa al
 * **arrancar** un proceso Node — asignarlo en caliente desde el test no alcanza a los
 * `worker_threads.Worker` que `tesseract.js` abre después (verificado antes de escribir este archivo).
 */
import { reconocerImagen } from '../../src/ocr.ts';

/** BMP de 24 bits sin comprimir, `ancho`×`alto`, todo blanco. Construido a mano: cero dependencias. */
function bmpBlanco(ancho: number, alto: number): Uint8Array {
  const stride = Math.ceil((ancho * 3) / 4) * 4;
  const bytesPixeles = stride * alto;
  const buffer = new Uint8Array(54 + bytesPixeles);
  const vista = new DataView(buffer.buffer);

  buffer[0] = 0x42;
  buffer[1] = 0x4d;
  vista.setUint32(2, buffer.length, true);
  vista.setUint32(10, 54, true);
  vista.setUint32(14, 40, true);
  vista.setInt32(18, ancho, true);
  vista.setInt32(22, alto, true);
  vista.setUint16(26, 1, true);
  vista.setUint16(28, 24, true);
  vista.setUint32(34, bytesPixeles, true);
  buffer.fill(0xff, 54);

  return buffer;
}

async function main(): Promise<void> {
  try {
    const resultado = await reconocerImagen(bmpBlanco(80, 40));
    process.stdout.write(JSON.stringify({ ok: true, pagina: resultado.pagina, palabras: resultado.palabras.length }));
  } catch (e) {
    const mensaje = e instanceof Error ? e.message : String(e);
    process.stdout.write(JSON.stringify({ ok: false, mensaje }));
  }
}

void main();
