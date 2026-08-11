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
  /**
   * Solo se usa cuando la carátula tiene más de una cuenta y el CBU declarado no se puede atribuir a
   * una sola moneda (ver el comentario de `leerCaratula`). En el resto de los casos se ignora: el CBU
   * se lee del archivo, nunca por argumento — mismos tres motivos de la cabecera del archivo.
   */
  cbu: z
    .string()
    .regex(/^\d{22}$/, 'el CBU tiene que ser de 22 dígitos')
    .optional(),
  /** Etiqueta humana. **Nunca** la razón social. */
  alias: z.string().max(60).optional(),
});

export type ArgumentosAltaDeCuenta = z.infer<typeof esquema>;

export function argumentos(argv: readonly string[] = process.argv.slice(2)): ArgumentosAltaDeCuenta {
  const mapa = new Map<string, string>();
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
        `El CBU NO se pasa por argumento salvo con --cbu <22 dígitos>, y solo hace falta cuando la ` +
        `carátula tiene más de una cuenta y no se puede atribuir el CBU declarado a una sola moneda ` +
        `(ver la cabecera de este script y el comentario de leerCaratula).`,
    );
  }
  return r.data;
}

/**
 * Cabeceras reales de Santander cuando la carátula trae más de una cuenta en el mismo documento (pesos +
 * dólares, cada una bajo su propio "Cuenta Corriente...Nº"). **Duplicadas a propósito** de
 * `packages/ingesta/src/adaptadores/santander.ts` (líneas 377/388/391), no importadas:
 * `packages/ingesta/src/index.ts` prohíbe exponer el vocabulario interno de un adaptador, y este script ya
 * es deliberadamente independiente del pipeline completo (no arma `FilaGeometrica`, no corre
 * `resolverAdaptador`).
 *
 * 🔴 El escape \u00BA (el ordinal Nº), no el carácter tipeado directo — mismo motivo que
 * `santander.ts:370-376`: Nº (U+00BA) y N° (U+00B0, el signo de grado) se ven casi iguales en
 * un editor, y un "arreglo" cosmético que cambiara uno por el otro no se notaría en el diff.
 *
 * 🟡 **El guardrail cruzado del test (`alta-cuenta.test.ts`) solo cubre `RE_CABECERA_CUENTA`**, vía
 * `reconoceSantander` (lo único público que la ejercita). `RE_NUMERO_CUENTA_EN_CABECERA` y
 * `RE_ES_DOLARES` NO tienen cross-check automatizado contra `santander.ts` — hoy están verificadas
 * carácter por carácter contra el original (`code-reviewer`, HANDOFF (34) enmienda), pero una
 * divergencia futura en esas dos no la agarra el gate. Declarado en
 * `docs/diseno/10-deuda-declarada.md`, no cerrado en este commit: hacerlo bien pide fabricar un
 * `FilaGeometrica[]` completo (encabezado + región + cierre) para correr `leerSantander` de verdad —
 * una fixture del tamaño de las de `santander.test.ts`, desproporcionada para este fix puntual.
 */
const RE_CABECERA_CUENTA = /^Cuenta Corriente.*N\u00BA/;
const RE_NUMERO_CUENTA_EN_CABECERA = /N\u00BA\s*(\d{3}-\d{6}\/\d)/;
const RE_ES_DOLARES = /especial\s+U\$S/i;

/**
 * Lee de la carátula lo que hace falta para el alta.
 *
 * **Por etiqueta, nunca por patrón libre.** Buscar "el primer número de 22 dígitos" encuentra el CBU de
 * una contraparte del cuerpo del extracto y lo toma por el del titular — el archivo real del piloto tiene
 * 113 corridas de once dígitos. El resultado sería una cuenta dada de alta con el identificador de un
 * tercero, y a partir de ahí **todos los extractos de ese cliente resolverían a la cuenta equivocada**.
 *
 * **Multi-cuenta (Santander).** El resumen de Santander imprime la cuenta en pesos y la cuenta en dólares
 * en el MISMO documento, cada una bajo su propia cabecera "Cuenta Corriente...Nº" (puede repetirse una vez
 * por página). El número de cuenta SÍ está atado a una cabecera — se filtra por `moneda` y se deduplica
 * por valor. El CBU, en cambio, se imprime una sola vez para todo el documento y nada lo ata a una de las
 * dos cuentas — mismo criterio que `santander.ts:817-832`, que lo deja explícitamente sin determinar
 * cuando hay más de una región: con más de una cabecera de cuenta en el documento, el CBU no se atribuye
 * solo, hace falta `--cbu` explícito.
 *
 * Sin esto, un CBU mal atribuido no solo es plausible: `altaDeCuentaBancaria` es idempotente por
 * `(cliente_id, pepper_id, cbu_hmac, vigente_desde)`, así que dar de alta la cuenta en dólares DESPUÉS de
 * la de pesos, con el mismo CBU (mal) leído y el mismo período, no fallaría ni crearía nada nuevo —
 * devolvería en silencio los ids de la cuenta en pesos ya cargada, y el CLI imprimiría "Alta OK" como si
 * hubiera registrado la cuenta en dólares.
 */
export function leerCaratula(
  texto: TextoDelPdf,
  moneda: 'ARS' | 'USD',
  cbuManual: string | undefined,
): {
  readonly cbu: string;
  readonly numero: string;
  readonly tipoCuenta: TipoCuentaAlta;
  readonly desde: string;
  readonly seccionUsada: string;
} {
  const lineas = aLineas(texto).map((l) => l.texto);
  const cabecerasCuenta = lineas.filter((l) => RE_CABECERA_CUENTA.test(l));

  let numero: string;
  let tipoCuenta: TipoCuentaAlta;
  let seccionUsada: string;
  let cbuAtribuido: string | undefined;

  if (cabecerasCuenta.length > 0) {
    const esUsdPedido = moneda === 'USD';
    const cabecerasDeLaMoneda = cabecerasCuenta.filter((l) => RE_ES_DOLARES.test(l) === esUsdPedido);
    const cabecerasDeLaOtraMoneda = cabecerasCuenta.filter((l) => RE_ES_DOLARES.test(l) !== esUsdPedido);

    const numerosDeLaMoneda = [
      ...new Set(
        cabecerasDeLaMoneda
          .map((l) => RE_NUMERO_CUENTA_EN_CABECERA.exec(l)?.[1])
          .filter((n): n is string => n !== undefined),
      ),
    ];
    if (numerosDeLaMoneda.length === 0) {
      throw new Error(
        `No encontré una sección "Cuenta Corriente" en ${moneda} en la carátula (hay ` +
          `${cabecerasCuenta.length} cabecera(s) de cuenta en el documento en total). Verificá --moneda.`,
      );
    }
    if (numerosDeLaMoneda.length > 1) {
      throw new Error(
        `Encontré ${numerosDeLaMoneda.length} números de cuenta distintos para ${moneda} en la ` +
          `carátula — no puedo elegir uno solo. Revisá el archivo.`,
      );
    }
    // Sano por construcción: los dos throws de arriba ya descartaron 0 y >1 elementos, así que acá
    // `numerosDeLaMoneda` tiene exactamente uno (mismo criterio que `toolkit.ts:915`).
    const numeroUnico = numerosDeLaMoneda[0] as string;

    // Cross-check: si el mismo número también aparece en la sección de la otra moneda, el filtro no
    // discriminó — nunca aceptar en silencio (seguridad-datos-financieros, HANDOFF (34) enmienda).
    const numerosDeLaOtraMoneda = new Set(
      cabecerasDeLaOtraMoneda
        .map((l) => RE_NUMERO_CUENTA_EN_CABECERA.exec(l)?.[1])
        .filter((n): n is string => n !== undefined),
    );
    if (numerosDeLaOtraMoneda.has(numeroUnico)) {
      throw new Error(
        'El número de cuenta encontrado coincide entre las dos monedas: el filtro no está discriminando ' +
          'la sección correcta. No sigo — revisá el archivo antes de reintentar.',
      );
    }

    numero = numeroUnico;
    tipoCuenta = esUsdPedido ? 'cuenta_corriente_especial' : 'cuenta_corriente';
    seccionUsada = esUsdPedido
      ? 'Cuenta Corriente especial U$S (Santander)'
      : 'Cuenta Corriente en Pesos (Santander)';

    if (cabecerasDeLaOtraMoneda.length > 0) {
      // Multi-cuenta real: el documento trae también la sección de la otra moneda. El CBU no se atribuye.
      if (!cbuManual) {
        throw new Error(
          'La carátula tiene más de una cuenta (pesos y dólares) y el CBU declarado no se puede ' +
            'atribuir a una sola moneda — mismo criterio que packages/ingesta/src/adaptadores/santander.ts. ' +
            'Pasá --cbu <22 dígitos> con el CBU real de esta cuenta.',
        );
      }
      cbuAtribuido = cbuManual;
    }
  } else {
    // Las etiquetas están documentadas en `docs/diseno/02-formato-galicia.md` §3. Las variantes cubren que
    // el banco cambie `Nro.` por `Número` entre versiones del resumen.
    /**
     * 🔴 Antes sin ancla derecha (`/N?°?\s*[\d\-/ ]{6,}/`): la clase `[\d\-/ ]` es greedy y sin `$`, así
     * que si sobrara texto después del número en la misma línea (otro campo numérico, o el inicio de la
     * etiqueta siguiente compartiendo fila), el match seguía comiendo mientras hubiera dígitos, guiones,
     * barras o espacios — captura de más, silenciosa. `galicia.ts` (`leerNumeroDeCuenta`) ya lee el mismo
     * dato con `^...$` anclado en los dos extremos; acá se alinea al mismo patrón, sobre el mismo formato.
     */
    const resultadoNumero = valorPorEtiqueta(
      lineas,
      ['Número de cuenta', 'Nro. de cuenta', 'Cuenta Nº', 'Cuenta N°'],
      /^N?°?\s*[\d\-/ ]{6,}$/,
      2,
    );
    if (!resultadoNumero) throw new Error('No encontré el número de cuenta por su etiqueta.');

    const tipo = valorPorEtiqueta(lineas, ['Tipo de cuenta'], /[A-Za-zÁÉÍÓÚÑáéíóúñ .]{4,}/, 2);

    // Se limpia el prefijo `N°` que el banco imprime pegado al valor.
    numero = resultadoNumero.valor.replace(/^N?°?\s*/, '').trim();
    tipoCuenta = clasificarTipo(tipo?.valor ?? '');
    seccionUsada = 'etiqueta genérica (Galicia u otro formato de una sola cuenta)';
  }

  if (cbuAtribuido === undefined) {
    /**
     * 🔴 `\b` de los dos lados, y **no es cosmético**.
     *
     * Sin los límites de palabra, una corrida de **23 dígitos** matchea sus primeros 22 y el alta guarda
     * un **CBU plausible e inexistente**. Y este es el peor lugar posible para que pase: el CBU que se
     * registra acá es contra lo que `resolverCuentaDelExtracto` compara **todos** los extractos futuros de
     * esa cuenta. Un dígito de más al leerlo y la cuenta queda dada de alta con un identificador que
     * **nunca va a resolver** — el operador ve `cuenta_no_registrada` para siempre sobre una cuenta que sí
     * registró. Con `\b`, una corrida de 23 **no matchea nada** y el alta falla ruidosa en vez de guardar
     * basura. Lo encontró el adaptador de Galicia al leer el mismo dato por la vía geométrica.
     */
    const cbuEncontrado = valorPorEtiqueta(lineas, ['CBU', 'C.B.U.'], /\b\d{22}\b/, 2);
    if (!cbuEncontrado) {
      throw new Error(
        'No encontré el CBU por su etiqueta en la carátula. NO se busca por patrón a propósito: un patrón ' +
          'encuentra el CBU de una contraparte del cuerpo y daría de alta la cuenta con el identificador de ' +
          'un tercero. Revisá que el archivo sea la primera página del resumen.',
      );
    }
    cbuAtribuido = cbuEncontrado.valor;
  }

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
    cbu: cbuAtribuido,
    numero,
    tipoCuenta,
    // La vigencia arranca con el período del extracto: es la primera fecha en la que sabemos que la cuenta
    // existía con este identificador. Poner "hoy" haría que un extracto de hace ocho meses no resuelva.
    desde: periodo.desde,
    seccionUsada,
  };
}

/**
 * Mapea el texto que imprime el banco a los seis valores del dominio.
 *
 * Cae en `no_determinado` y **no adivina**: un tipo mal clasificado decide si el descubierto es posible y si
 * el saldo va a Banco o a Inversiones. Es mejor un `no_determinado` que una persona corrige que un
 * `caja_ahorro` inventado que nadie revisa.
 */
export function clasificarTipo(texto: string): TipoCuentaAlta {
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
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/alta-cuenta.ts');

if (esEjecucionDirecta) {
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

  const caratula = leerCaratula(texto, args.moneda, args.cbu);

  // Lo que se imprime es la FORMA, para poder confirmar a ojo que se leyó la celda correcta sin publicar
  // el valor. `forma()` no conserva ni un dígito ni una letra del original. `seccionUsada` sí se imprime
  // en texto completo: es una constante del programa (qué rótulo matcheó), nunca la línea real del
  // documento — permite confirmar que el filtro por moneda entró por la sección correcta.
  imprimir('');
  imprimir('  Leído de la carátula (formas, no valores):');
  imprimir(`    Moneda pedida     ${args.moneda}`);
  imprimir(`    Sección leída     ${caratula.seccionUsada}`);
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
       * El motivo es obligatorio y va escrito: dentro de seis meses, "quién dio de alta esta cuenta y por
       * qué" tiene que ser una pregunta contestable.
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
}
