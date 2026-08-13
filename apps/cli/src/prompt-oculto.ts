/**
 * PROMPT OCULTO — lee un valor sensible de `stdin` sin ecoarlo, nunca por `argv` ni por variable de
 * entorno. Extraído de `apps/cli/src/alta-cuenta.ts` (HANDOFF (36)/(37)) para reusarlo en
 * `apps/cli/src/alta-socio.ts` (el CUIT/CUIL de un socio es la misma clase de riesgo que el CBU:
 * historial de PowerShell en texto plano, línea de comandos legible por cualquier proceso del mismo
 * usuario, contexto de un agente — ADR-0002 §F.2.5).
 *
 * La validación de FORMA (22 dígitos para CBU, 11 para CUIT/CUIL) queda del lado del llamador: cada
 * identificador tiene la suya.
 */

const SALTO = String.fromCharCode(10);

/** El subconjunto de `process.stdin` que hace falta para leer sin ecoar. Así se puede inyectar un doble en tests. */
export type EntradaOculta = {
  readonly isTTY: boolean | undefined;
  setRawMode(modo: boolean): void;
  resume(): void;
  pause(): void;
  setEncoding(codificacion: BufferEncoding): void;
  on(evento: 'data', escucha: (fragmento: string) => void): void;
  removeListener(evento: 'data', escucha: (fragmento: string) => void): void;
};

/** El subconjunto de `process.stdout` que hace falta para escribir el prompt. Mismo motivo que `EntradaOculta`. */
export type SalidaOculta = {
  write(texto: string): boolean;
};

/** Se lanza cuando el operador cancela el prompt con Ctrl+C. Nunca lleva el valor tipeado. */
export class PedidoOcultoCancelado extends Error {}

/**
 * Lee un valor de `stdin` en modo raw, **sin ecoar un solo carácter** — ni siquiera asteriscos: dos
 * identificadores del mismo largo se ven idénticos bajo cualquier máscara por posición, así que ni
 * un asterisco por tecla aporta nada y sí deja ver la longitud tipeada. El valor nunca pasa por
 * `argv` ni por una variable de entorno, así que no lo agarra `PSReadLine`.
 *
 * Restaura el modo de la terminal en TODOS los caminos de salida — Enter, Ctrl+C, o cualquier
 * excepción que ocurra después, en cualquier otra parte del proceso, mientras el raw mode siguiera
 * activo (ver el `process.on('exit', ...)` en `pedirValorConfirmado`).
 */
export function pedirValorOculto(
  mensaje: string,
  entrada: EntradaOculta = process.stdin,
  salida: SalidaOculta = process.stdout,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!entrada.isTTY) {
      reject(
        new Error(
          'No hay una terminal interactiva para pedir este valor. Corré el script desde una consola ' +
            'real, no con stdin redirigido ni en un pipeline no interactivo.',
        ),
      );
      return;
    }

    salida.write(mensaje);
    entrada.setRawMode(true);
    entrada.resume();
    entrada.setEncoding('utf8');

    let buffer = '';
    const cerrar = (): void => {
      entrada.setRawMode(false);
      entrada.pause();
      entrada.removeListener('data', onData);
    };

    // Recorre TODO el fragmento, no solo el último carácter: un `paste` con el Enter incluido llega
    // en un solo evento `data`, y mirar solo `fragmento.at(-1)` se comería el corte de línea en silencio.
    const onData = (fragmento: string): void => {
      for (const caracter of fragmento) {
        if (caracter === '\u0003') {
          cerrar();
          salida.write(SALTO);
          reject(new PedidoOcultoCancelado('Cancelado por el operador (Ctrl+C).'));
          return;
        }
        if (caracter === '\r' || caracter === '\n') {
          cerrar();
          salida.write(SALTO);
          resolve(buffer);
          return;
        }
        if (caracter === '\u007f' || caracter === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += caracter;
      }
    };
    entrada.on('data', onData);
  });
}

export type EtiquetasDePrompt = {
  readonly primero: string;
  readonly segundo: string;
  readonly aviso: readonly string[];
};

/**
 * Pide un valor DOS VECES y exige que coincidan byte a byte antes de aceptarlo — generaliza
 * `pedirCbuConfirmado` (HANDOFF (36)): mostrar `forma(valor)` después de tipearlo no sirve para que
 * el operador se autoverifique, porque dos valores del mismo largo producen la misma forma. El único
 * chequeo posible sin mostrar el valor en pantalla es pedirlo dos veces y compararlas.
 *
 * Ninguno de los `throw` interpola el valor tipeado, a propósito — mismo tipo de fuga que ya pasó una
 * vez en este repo por un mensaje "más claro" (ADR-0002 §H.3.bis).
 */
export async function pedirValorConfirmado(
  etiquetas: EtiquetasDePrompt,
  entrada: EntradaOculta = process.stdin,
  salida: SalidaOculta = process.stdout,
): Promise<string> {
  // Red de seguridad: si algo más adelante en el proceso tira una excepción sin atrapar mientras el
  // raw mode sigue activo, la terminal no debe quedar sin eco para el usuario después de que el
  // script salió. Se remueve en el `finally` de abajo apenas esta función termina — de lo contrario,
  // acumula un listener sobre `process` por cada llamada.
  const restaurarAlSalir = (): void => {
    if (entrada.isTTY) entrada.setRawMode(false);
  };
  process.on('exit', restaurarAlSalir);

  try {
    salida.write(SALTO);
    for (const linea of etiquetas.aviso) salida.write(`  ${linea}${SALTO}`);
    salida.write(SALTO);

    const primero = await pedirValorOculto(etiquetas.primero, entrada, salida);
    const segundo = await pedirValorOculto(etiquetas.segundo, entrada, salida);

    if (primero !== segundo) {
      throw new Error('Los dos valores tipeados no coinciden. Volvé a correr el comando y tipealo con cuidado.');
    }
    return primero;
  } finally {
    process.removeListener('exit', restaurarAlSalir);
  }
}
