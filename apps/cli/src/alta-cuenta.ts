/**
 * ALTA DE UNA CUENTA BANCARIA — lee la carátula del PDF y **nunca imprime el identificador**.
 *
 *     node apps/cli/src/alta-cuenta.ts \
 *       --cliente <uuid> --usuario <uuid> --banco galicia --archivo <ruta al PDF>
 *
 * ## Por qué el CBU se lee del archivo y no se pasa por argumento
 *
 * Tres razones, y las tres son caminos por los que un identificador se escapa a lugares donde ningún control
 * del proyecto llega:
 *
 * 1. **El historial de la terminal.** Un `--cbu 0170…` queda en
 *    `PSReadLine\ConsoleHost_history.txt`: texto plano, permanente, **fuera del repo, fuera del barrido de
 *    fuga y fuera del `.gitignore`**, y sincronizado a cualquier backup de perfil que tenga la máquina.
 * 2. **La línea de comandos de un proceso** la puede leer cualquier proceso del mismo usuario, y la captura
 *    cualquier agente de EDR.
 * 3. **El contexto de un agente.** ADR-0002 §F.2.5 prohíbe pegar datos reales en el contexto de un LLM, y
 *    §H.3.bis es el precedente: los ocho controles estaban cerrados y la fuga entró igual, por cuatro
 *    importes que se escribieron en comentarios mientras se miraba el archivo real.
 *
 * El archivo ya está en `privado/`, que es el lugar autorizado. Leerlo desde ahí, hashear y insertar es el
 * camino más corto entre el dato y la base: **el valor no pasa por ninguna otra parte.**
 *
 * ## Qué imprime
 *
 * uuid, el tipo de cuenta, la **forma** de los identificadores leídos y conteos. Nunca un valor. Así la
 * salida se puede pegar en un ticket sin pensarlo.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  aLineas,
  extraerPeriodo,
  extraerTexto,
  valorPorEtiqueta,
  type TextoDelPdf,
} from '@sistema-contable/ingesta';
import { forma } from '@sistema-contable/shared/observabilidad';
import { cargarEnv } from '../../../tools/cargar-env.ts';
import {
  altaDeCuentaBancaria,
  cerrarConexiones,
  conUsuario,
  escribirConAuditoria,
  verificarCredencialDeRequest,
  type TipoCuentaAlta,
} from '@sistema-contable/data';

cargarEnv();

const SALTO = String.fromCharCode(10);
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esquema = z.object({
  cliente: z.string().regex(RE_UUID),
  usuario: z.string().regex(RE_UUID),
  banco: z.string().regex(/^[a-z0-9_]{2,32}$/),
  archivo: z.string().min(1),
  moneda: z.enum(['ARS', 'USD']).default('ARS'),
  /** Etiqueta humana. **Nunca** la razón social. */
  alias: z.string().max(60).optional(),
});

function argumentos(): z.infer<typeof esquema> {
  const mapa = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a?.startsWith('--')) {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) {
        mapa.set(a.slice(2), v);
        i += 1;
      }
    }
  }

  const r = esquema.safeParse(Object.fromEntries(mapa));
  if (!r.success) {
    throw new Error(
      `Argumentos inválidos: ${r.error.issues.map((i) => `--${String(i.path[0])}`).join(', ')}.${SALTO}${SALTO}` +
        `  node apps/cli/src/alta-cuenta.ts --cliente <uuid> --usuario <uuid> \\${SALTO}` +
        `    --banco <codigo> --archivo <ruta al PDF> [--moneda ARS] [--alias "cuenta operativa"]${SALTO}${SALTO}` +
        `El CBU NO se pasa por argumento: se lee de la carátula del archivo. Ver la cabecera de este script.`,
    );
  }
  return r.data;
}

/**
 * Lee de la carátula lo que hace falta para el alta.
 *
 * **Por etiqueta, nunca por patrón.** Buscar "el primer número de 22 dígitos" encuentra el CBU de una
 * contraparte del cuerpo del extracto y lo toma por el del titular — el archivo real del piloto tiene 113
 * corridas de once dígitos. El resultado sería una cuenta dada de alta con el identificador de un tercero, y
 * a partir de ahí **todos los extractos de ese cliente resolverían a la cuenta equivocada**.
 */
function leerCaratula(texto: TextoDelPdf): {
  readonly cbu: string;
  readonly numero: string;
  readonly tipoCuenta: TipoCuentaAlta;
  readonly desde: string;
} {
  const lineas = aLineas(texto).map((l) => l.texto);

  // Las etiquetas están documentadas en `docs/diseno/02-formato-galicia.md` §3. Las variantes cubren que el
  // banco cambie `Nro.` por `Número` entre versiones del resumen.
  /**
   * 🔴 `\b` de los dos lados, y **no es cosmético**.
   *
   * Sin los límites de palabra, una corrida de **23 dígitos** matchea sus primeros 22 y el alta guarda un
   * **CBU plausible e inexistente**. Y este es el peor lugar posible para que pase: el CBU que se registra
   * acá es contra lo que `resolverCuentaDelExtracto` compara **todos** los extractos futuros de esa cuenta.
   * Un dígito de más al leerlo y la cuenta queda dada de alta con un identificador que **nunca va a
   * resolver** — el operador ve `cuenta_no_registrada` para siempre sobre una cuenta que sí registró.
   *
   * Con `\b`, una corrida de 23 **no matchea nada** y el alta falla ruidosa en vez de guardar basura.
   * Lo encontró el adaptador de Galicia al leer el mismo dato por la vía geométrica.
   */
  const cbu = valorPorEtiqueta(lineas, ['CBU', 'C.B.U.'], /\b\d{22}\b/, 2);
  /**
   * 🔴 Antes sin ancla derecha (`/N?°?\s*[\d\-/ ]{6,}/`): la clase `[\d\-/ ]` es greedy y sin `$`, así que
   * si sobrara texto después del número en la misma línea (otro campo numérico, o el inicio de la etiqueta
   * siguiente compartiendo fila), el match seguía comiendo mientras hubiera dígitos, guiones, barras o
   * espacios — captura de más, silenciosa. `galicia.ts` (`leerNumeroDeCuenta`) ya lee el mismo dato con
   * `^...$` anclado en los dos extremos; acá se alinea al mismo patrón, sobre el mismo formato de archivo.
   */
  const numero = valorPorEtiqueta(
    lineas,
    ['Número de cuenta', 'Nro. de cuenta', 'Cuenta Nº', 'Cuenta N°'],
    /^N?°?\s*[\d\-/ ]{6,}$/,
    2,
  );
  const tipo = valorPorEtiqueta(lineas, ['Tipo de cuenta'], /[A-Za-zÁÉÍÓÚÑáéíóúñ .]{4,}/, 2);

  if (!cbu) {
    throw new Error(
      'No encontré el CBU por su etiqueta en la carátula. NO se busca por patrón a propósito: un patrón ' +
        'encuentra el CBU de una contraparte del cuerpo y daría de alta la cuenta con el identificador de ' +
        'un tercero. Revisá que el archivo sea la primera página del resumen.',
    );
  }
  if (!numero) throw new Error('No encontré el número de cuenta por su etiqueta.');

  const periodo = extraerPeriodo(lineas.join(SALTO));
  if (!periodo) {
    /**
     * **Sin período no se inventa una fecha.**
     *
     * La primera versión caía a `2000-01-01` como fallback, y eso es peor que fallar: una vigencia inventada
     * hace que el identificador resuelva para cualquier extracto, incluidos los de antes de que la cuenta
     * existiera. Y nadie revisa una fecha que el sistema puso solo.
     */
    throw new Error(
      'No pude leer el período del resumen, y no invento una fecha de vigencia: una vigencia inventada ' +
        'hace que el identificador resuelva para extractos de antes de que la cuenta existiera. Pasá el ' +
        'archivo correcto o agregá la variante de etiqueta que use este banco.',
    );
  }

  return {
    cbu: cbu.valor,
    // Se limpia el prefijo `N°` que el banco imprime pegado al valor.
    numero: numero.valor.replace(/^N?°?\s*/, '').trim(),
    tipoCuenta: clasificarTipo(tipo?.valor ?? ''),
    // La vigencia arranca con el período del extracto: es la primera fecha en la que sabemos que la cuenta
    // existía con este identificador. Poner "hoy" haría que un extracto de hace ocho meses no resuelva.
    desde: periodo.desde,
  };
}

/**
 * Mapea el texto que imprime el banco a los seis valores del dominio.
 *
 * Cae en `no_determinado` y **no adivina**: un tipo mal clasificado decide si el descubierto es posible y si
 * el saldo va a Banco o a Inversiones. Es mejor un `no_determinado` que una persona corrige que un
 * `caja_ahorro` inventado que nadie revisa.
 */
function clasificarTipo(texto: string): TipoCuentaAlta {
  const t = texto.toUpperCase();
  if (t.includes('ESPECIAL')) return 'cuenta_corriente_especial';
  if (t.includes('CORRIENTE')) return 'cuenta_corriente';
  if (t.includes('AHORRO')) return 'caja_ahorro';
  if (t.includes('INVERSION') || t.includes('INVERSIÓN')) return 'cuenta_inversion';
  if (t.includes('TARJETA')) return 'tarjeta_corporativa';
  return 'no_determinado';
}

function imprimir(t: string): void {
  process.stdout.write(t + SALTO);
}

// -----------------------------------------------------------------------------

const args = argumentos();

// El guard, ANTES de abrir el archivo: si va a abortar, que aborte sin el extracto en memoria (R18).
const credencial = await verificarCredencialDeRequest();
if (credencial.salteaRls || credencial.esSuperusuario) {
  imprimir('');
  imprimir('  ABORTA: la credencial de DATABASE_URL_APP saltea RLS o es superusuario.');
  imprimir('  El alta de una cuenta con las políticas fuera de juego escribe sin verificar el tenant.');
  imprimir('');
  process.exit(1);
}

const contenido = readFileSync(args.archivo);
const texto = await extraerTexto(contenido);
if (texto.requiereOcr) {
  imprimir('  ABORTA: el PDF no tiene texto extraíble (es un escaneo). No hay carátula que leer.');
  process.exit(1);
}

const caratula = leerCaratula(texto);

// Lo que se imprime es la FORMA, para poder confirmar a ojo que se leyó la celda correcta sin publicar el
// valor. `forma()` no conserva ni un dígito ni una letra del original.
imprimir('');
imprimir('  Leído de la carátula (formas, no valores):');
imprimir(`    CBU               ${forma(caratula.cbu)}`);
imprimir(`    Número de cuenta  ${forma(caratula.numero)}`);
imprimir(`    Tipo de cuenta    ${caratula.tipoCuenta}`);
imprimir(`    Vigente desde     ${caratula.desde}`);
imprimir('');

try {
  const resultado = await conUsuario(args.usuario, (tx) =>
    /**
     * El alta va dentro de `escribirConAuditoria`: es la única forma de llamar a `altaDeCuentaBancaria`,
     * porque su firma exige el `ContextoAuditado` que solo se fabrica ahí.
     *
     * El motivo es obligatorio y va escrito: dentro de seis meses, "quién dio de alta esta cuenta y por qué"
     * tiene que ser una pregunta contestable.
     */
    escribirConAuditoria(
      tx,
      {
        clienteId: args.cliente,
        accion: 'escritura',
        recurso: 'cuenta_bancaria_identificador',
        motivo: `alta de cuenta ${args.banco} desde la caratula del resumen, piloto Modulo 1`,
      },
      (ctx) =>
        altaDeCuentaBancaria(tx, ctx, {
          clienteId: args.cliente,
          bancoCodigo: args.banco,
          moneda: args.moneda,
          alias: args.alias,
          tipoCuenta: caratula.tipoCuenta,
          numero: caratula.numero,
          cbu: caratula.cbu,
          vigenteDesde: caratula.desde,
        }),
    ),
  );

  imprimir('  Alta OK.');
  imprimir(`    cuenta_bancaria_id  ${resultado.cuentaBancariaId}`);
  imprimir(`    identificador_id    ${resultado.identificadorId}`);
  imprimir(`    pepper_id           ${resultado.pepperId}`);
  imprimir('');
  imprimir('  El CBU quedó SOLO como HMAC. El valor completo no se guardó en ninguna columna.');
  imprimir('');
} finally {
  await cerrarConexiones();
}
