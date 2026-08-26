/**
 * ALTA DE UNA CUENTA BANCARIA — lee la carátula del PDF y **nunca imprime el identificador**.
 *
 *     node apps/cli/src/alta-cuenta.ts \
 *       --cliente <uuid> --usuario <uuid> --banco galicia --archivo <ruta al PDF>
 *
 * ## Por qué el CBU se lee del archivo y no se pasa por argumento — NUNCA, ni con `--cbu`
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
 * 🔴 **`--cbu` NO existe como argumento — a propósito, dos veces.** El fix de multi-cuenta (HANDOFF
 * 2026-08-11 (34)/(35)) lo agregó como argumento para el caso en que la carátula trae más de una cuenta y
 * el CBU no se puede atribuir a una sola moneda, y eso reintrodujo exactamente el riesgo 1 de arriba —
 * detectado por el usuario, no por la convocatoria original (HANDOFF (36)). Para ese caso, `argumentos()`
 * rechaza cualquier `--cbu` explícito con un error, y la CLI real pide el valor con un prompt interactivo
 * oculto (`pedirCbuConfirmado`, más abajo): lee de `stdin` en modo raw, sin ecoar ni un carácter, nunca pasa
 * por `argv` ni por una variable de entorno, y pide el valor **dos veces** para detectar un error de
 * transcripción sin necesidad de mostrarlo en pantalla (`forma()` no sirve acá: todo CBU de 22 dígitos
 * produce la misma forma, así que no hay manera de que el operador confirme a ojo que tipeó el correcto).
 *
 * ## Qué imprime
 *
 * uuid, el tipo de cuenta, la **forma** de los identificadores leídos y conteos. Nunca un valor. Así la
 * salida se puede pegar en un ticket sin pensarlo.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  aFilas,
  aLineas,
  extraerPeriodo,
  extraerTexto,
  reconoceBancor,
  reconoceICBC,
  reconoceNacion,
  seccionesPorClave,
  valorPorEtiqueta,
  type FilaGeometrica,
  type SeccionDetectada,
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
import {
  pedirValorConfirmado,
  pedirValorOculto,
  PedidoOcultoCancelado,
  type EntradaOculta,
  type SalidaOculta,
} from './prompt-oculto.ts';

export { pedirValorOculto, type EntradaOculta, type SalidaOculta };
/** Alias — mismo tipo que `PedidoOcultoCancelado` (`prompt-oculto.ts`), conservado para no romper
 *  el import existente de `apps/cli/tests/alta-cuenta.test.ts`. */
export const PedidoDeCbuCancelado = PedidoOcultoCancelado;

cargarEnv();

const SALTO = String.fromCharCode(10);
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Los tipos que `--tipo` acepta — el subconjunto de `TipoCuentaAlta` que Macro realmente distingue en
 * su carátula (`dba-data`, HANDOFF (38)). `cuenta_inversion`/`tarjeta_corporativa`/`no_determinado`
 * quedan afuera a propósito: no aplican a este flujo de lectura y ofrecerlos como respuesta a una
 * ambigüedad de carátula sería confuso.
 *
 * `as const satisfies readonly TipoCuentaAlta[]` en vez de filtrar `TIPOS_CUENTA_ALTA` en tiempo de
 * ejecución: así `z.enum(...)` conserva el tipo literal (lo que un `.filter()` sobre el array pierde,
 * `z.enum` infiere `string` a secas) y a la vez el compilador rechaza este archivo si algún día alguno
 * de estos tres strings dejara de ser un `TipoCuentaAlta` válido — no es una cuarta lista libre.
 */
const TIPOS_PARA_DESAMBIGUAR = [
  'cuenta_corriente',
  'cuenta_corriente_especial',
  'caja_ahorro',
] as const satisfies readonly TipoCuentaAlta[];

const esquema = z.object({
  cliente: z.string().regex(RE_UUID),
  usuario: z.string().regex(RE_UUID),
  banco: z.string().regex(/^[a-z0-9_]{2,32}$/),
  archivo: z.string().min(1),
  moneda: z.enum(['ARS', 'USD']).default('ARS'),
  /**
   * Solo hace falta cuando la carátula tiene más de una cuenta en la misma moneda (caso real: Macro,
   * dos cuentas en ARS de tipo distinto) y `--moneda` sola no alcanza para elegir. No es sensible —
   * a diferencia del CBU, ya se imprime hoy en claro en la salida — así que pasarlo por argumento no
   * reintroduce el problema de (36)/(37).
   */
  tipo: z.enum(TIPOS_PARA_DESAMBIGUAR).optional(),
  /** Etiqueta humana. **Nunca** la razón social. */
  alias: z.string().max(60).optional(),
});

export type ArgumentosAltaDeCuenta = z.infer<typeof esquema>;

export function argumentos(argv: readonly string[] = process.argv.slice(2)): ArgumentosAltaDeCuenta {
  /**
   * 🔴 Chequeo explícito, ANTES del parseo de Zod — no alcanza con que `--cbu` no esté en `esquema`.
   *
   * `z.object(...)` sin `.strict()` descarta claves desconocidas en silencio: si alguien tipea `--cbu
   * <valor>` (por hábito, por un runbook viejo, por copiar un comando de una entrada vieja de HANDOFF),
   * Zod lo ignora y el script sigue como si nada — pero el valor **ya quedó grabado** en
   * `ConsoleHost_history.txt` en el momento en que se apretó Enter, antes de que Node procese una sola
   * línea (`security-engineer`, HANDOFF (36)). Sin este chequeo, el operador no tiene ninguna señal de que
   * acaba de repetir exactamente el error que la cabecera del archivo prohíbe.
   *
   * 🔴 **También `--cbu=valor`, no solo `--cbu valor`** (`code-reviewer`, HANDOFF (36)). El loop de parseo
   * de más abajo exige que el token siguiente NO empiece con `--` para consumirlo como valor — con
   * `--cbu=X` el "valor" queda pegado al propio flag y ese loop simplemente lo descarta sin verlo, así que
   * sin este segundo chequeo `--cbu=<22 dígitos>` pasaba en **silencio total**: ni error, ni recordatorio
   * de limpiar el historial. El CBU ya había quedado grabado igual.
   */
  if (argv.some((a) => a === '--cbu' || a.startsWith('--cbu='))) {
    throw new Error(
      `--cbu ya no es un argumento válido: quedaría en texto plano en el historial de PowerShell, que es ` +
        `exactamente lo que este script evita (ver la cabecera de este archivo).${SALTO}${SALTO}` +
        `Si lo tipeaste, esa línea YA quedó grabada — revisá y limpiá tu historial ` +
        `((Get-PSReadlineOption).HistorySavePath) antes de seguir.${SALTO}${SALTO}` +
        `El CBU ahora se pide en un prompt interactivo oculto, solo cuando hace falta (documento con más ` +
        `de una cuenta) — no hace falta pasarlo por argumento nunca.`,
    );
  }

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
        `    --banco <codigo> --archivo <ruta al PDF> [--moneda ARS] [--tipo <tipo>] ` +
        `[--alias "cuenta operativa"]${SALTO}${SALTO}` +
        `El CBU NO se pasa por argumento, nunca: se lee del archivo, o si la carátula tiene más de una ` +
        `cuenta, se pide con un prompt interactivo oculto en el momento.${SALTO}` +
        `--tipo (${TIPOS_PARA_DESAMBIGUAR.join('|')}) solo hace falta cuando --moneda sola encuentra más ` +
        `de una cuenta candidata (caso Macro: dos cuentas en la misma moneda, de tipo distinto).`,
    );
  }
  return r.data;
}

/**
 * Cabecera de sección de Macro, cuando la carátula trae más de una cuenta (HANDOFF (38)). **Duplicada a
 * propósito** de `packages/ingesta/src/adaptadores/macro.ts` (líneas 238-239) — mismo motivo que las
 * de Santander más abajo: `packages/ingesta/src/index.ts` prohíbe exponer vocabulario interno de un
 * adaptador.
 *
 * **El particionado en secciones NO se duplica** — `seccionesPorClave` (importada de
 * `@sistema-contable/ingesta`) es infraestructura **compartida** de `toolkit.ts`, no vocabulario privado
 * de este banco: ya tiene dos usuarios reales (`macro.ts` y este archivo), y resuelve el caso medido de
 * que el encabezado se repite una vez por página y a veces se reabre fuera de orden — reinventar esa
 * lógica acá sería la clase de duplicación que el proyecto NO quiere (`tech-lead`, HANDOFF (38)).
 *
 * 🟡 **El guardrail cruzado de test que sí existe para las regex de Santander (vía `reconoceSantander`)
 * no tiene equivalente acá**: `reconoceMacro` no ejercita `RE_SECCION_MACRO` ni `RE_CBU_MACRO`. Se
 * acepta como deuda declarada, mismo criterio que ya cubre `docs/diseno/10-deuda-declarada.md` §2.11
 * para las otras dos regex de Santander — verificadas carácter por carácter contra el original en vez
 * de con cross-check automatizado (`tech-lead`, HANDOFF (38)).
 *
 * 🔴 **El CBU real de Macro trae guiones** (`#######-#-#############-#`, no 22 dígitos limpios como
 * Galicia/Santander) — se limpia y se valida antes de aceptarlo, ver más abajo en `leerCaratula`.
 */
const RE_SECCION_MACRO = /^(CUENTA(?: [A-ZÁÉÍÓÚÑ.]+)+) NRO\.:\s*(\d-\d{3}-\d{10}-\d)$/;
const RE_CBU_MACRO = /^Clave Bancaria Uniforme para Debito Directo:\s*(\S+)/;

function claveDeSeccionMacro(texto: string): string | null {
  return RE_SECCION_MACRO.exec(texto)?.[2] ?? null;
}

/** Mismo criterio que `macro.ts:1325-1328` — duplicado, no importado (vocabulario interno del adaptador). */
function tipoDeCuentaDelTituloMacro(titulo: string): TipoCuentaAlta {
  if (/ESPECIAL/i.test(titulo)) return 'cuenta_corriente_especial';
  if (/CORRIENTE/i.test(titulo)) return 'cuenta_corriente';
  if (/AHORRO/i.test(titulo)) return 'caja_ahorro';
  return 'no_determinado';
}

/**
 * Mismo criterio que `macro.ts:1320-1321` — duplicado, no importado.
 *
 * 🟡 Default a ARS cuando el título no nombra la moneda — es el caso real de "CUENTA CORRIENTE
 * BANCARIA" (sin "PESOS" ni "DOLARES"). El adaptador real sostiene ese default con una invariante de
 * todo el documento (la suma de movimientos contra "Saldo Cuentas en <moneda>") que esta función NO
 * reconstruye — `leerCaratula` solo lee carátula, nunca el cuerpo. Riesgo aceptado, mismo perfil que el
 * resto de esta función (`tech-lead`, HANDOFF (38)).
 */
function monedaDelTituloMacro(titulo: string): 'ARS' | 'USD' {
  return /D[OÓ]LAR/i.test(titulo) ? 'USD' : 'ARS';
}

/**
 * Conteo **aproximado** de renglones de movimiento dentro de una sección — nunca el conteo canónico
 * (ese lo hace `macro.ts` con la vista geométrica completa). Alcanza para que un mensaje de ambigüedad
 * le muestre al operador una diferencia bien distinguible entre dos cuentas candidatas (11 vs. 1335, el
 * caso real) sin depender de que confirme por el nombre exacto del tipo — que es circular si ya se
 * equivocó de tipo (`seguridad-datos-financieros`, HANDOFF (38)). Nunca se persiste, es solo de consola.
 */
function contarMovimientosMacro(seccion: SeccionDetectada, lineas: readonly string[]): number {
  return seccion.indices.filter((i) => /^\d{2}\/\d{2}\/\d{2}\b/.test(lineas[i] ?? '')).length;
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
 * \uD83D\uDD34 **Bancor fue la primera rama de `leerCaratula` que necesit\u00F3 geometr\u00EDa (`aFilas`), no texto
 * plano (`aLineas`)** \u2014 y esto se midi\u00F3, no se asumi\u00F3 por analog\u00EDa con el adapter. (Nota de
 * `code-reviewer`: Naci\u00F3n agreg\u00F3 una segunda rama geom\u00E9trica m\u00E1s abajo por el mismo motivo \u2014 esta
 * nota describe por qu\u00E9 Bancor la necesit\u00F3 primero, ya no es la \u00FAnica.)
 *
 * Las otras tres ramas (Macro, Santander, gen\u00E9rica) leen por ETIQUETA o por una cabecera de texto
 * reconocible, y `aLineas()` \u2014el texto del content-stream, en su propio orden interno\u2014 alcanza para
 * eso: no importa en qu\u00E9 orden salgan las l\u00EDneas mientras la etiqueta y su valor sigan adyacentes.
 * Bancor no imprime NINGUNA etiqueta para el n\u00FAmero de cuenta ni para el CBU \u2014 est\u00E1n por forma y
 * posici\u00F3n, sin r\u00F3tulo (mismo dato que ya resuelve el adapter, `bancor.ts::leerNumeroDeCuentaBancor`/
 * `leerCbuBancor`, v\u00EDa `aFilas`).
 *
 * **El primer intento fue con `aLineas()`, acotado a las primeras N l\u00EDneas** (mismo criterio de "forma
 * + ventana acotada a la car\u00E1tula" que el resto de este archivo usa para no agarrar el identificador de
 * una contraparte del cuerpo) \u2014 y **fall\u00F3 contra el PDF real**: `aLineas()` reordena la car\u00E1tula de
 * Bancor. El pie legal completo del documento aparece ANTES que el cuerpo de la car\u00E1tula en esa vista
 * (orden del content-stream, no orden visual) \u2014 la ventana de l\u00EDneas nunca llega al n\u00FAmero/CBU reales,
 * que quedan mucho m\u00E1s all\u00E1 de la car\u00E1tula "visual". Verificado con un script de solo lectura contra el
 * archivo real, dos veces (antes y despu\u00E9s de este cambio) \u2014 nunca se ensanch\u00F3 la ventana como arreglo:
 * eso habr\u00EDa debilitado la protecci\u00F3n real que la ventana acotada da contra leer el identificador de un
 * tercero del cuerpo, sin resolver la causa (el desorden de `aLineas()`).
 *
 * `aFilas()` s\u00ED preserva el orden VISUAL (reconstruye filas por coordenada, no por content-stream) \u2014 es
 * la misma v\u00EDa que ya usa el propio adapter, y es una de las cinco ramas de esta funci\u00F3n que la
 * necesita (la otra: Naci\u00F3n, m\u00E1s abajo). `reconoceBancor` (p\u00FAblico, de `@sistema-contable/ingesta`)
 * se reusa tal cual para la detecci\u00F3n \u2014 no se duplica, a diferencia de las regex de Macro/Santander,
 * porque ya es parte de la
 * superficie p\u00FAblica del paquete.
 */
const FILAS_DE_CARATULA_BANCOR = 20;
const RE_NUMERO_CUENTA_BANCOR = /(?<!\d)\d{5}\/\d{2}(?!\d)/;
const RE_CBU_BANCOR = /\b\d{22}\b/;

/**
 * 🔴 **Nación es la SEGUNDA rama de `leerCaratula` que necesita geometría (`aFilas`), no texto plano
 * — mismo motivo que Bancor.** Nación tampoco imprime NINGUNA etiqueta para el número de cuenta ni
 * para el CBU (`docs/diseno/21-formato-nacion.md` §2) — están por forma y posición, sin rótulo, mismo
 * dato que ya resuelve el adapter (`nacion.ts`, vía `fragmentoDeColumna`/regex locales). A diferencia
 * de Bancor, acá no hizo falta descartar `aLineas()` por reordenamiento del content-stream — no se
 * midió ese problema en el único documento real disponible — pero como de todos modos no hay etiqueta
 * que buscar, el mecanismo geométrico es el único que puede encontrar el dato sin importar el orden.
 *
 * Ventana y regex **verificadas con un script de solo lectura contra el PDF real antes de escribir
 * esta rama** (mismo protocolo que Bancor): número y CBU aparecen en la MISMA fila (16), exactamente
 * un match de cada patrón dentro de las primeras 20 filas — sin ambigüedad.
 */
const FILAS_DE_CARATULA_NACION = 20;
const RE_NUMERO_CUENTA_NACION = /(?<!\d)\d{10}(?!\d)/;
const RE_CBU_NACION = /\b\d{22}\b/;

/**
 * 🔴 **El período de Nación no lo puede leer `extraerPeriodo` (`toolkit.ts`), compartida con
 * Galicia/Macro.** Esa función exige el conector ("al"/"hasta") en MINÚSCULAS — sin flag `i` — y
 * el documento real de Nación lo imprime en MAYÚSCULAS ("AL"), confirmado por `formaParaLog` contra
 * el archivo real (el token se enmascaró como dos letras mayúsculas, nunca minúsculas). Mismo
 * patrón que `RE_PERIODO` de `nacion.ts` (el adapter, ya medido y probado), duplicado a propósito
 * acá — igual criterio que las regex de número/CBU: no se toca `extraerPeriodo` compartida bajo la
 * presión de un alta real sin la revisión que le corresponde a un cambio de comportamiento
 * compartido con otros dos bancos (declarado en `docs/diseno/10-deuda-declarada.md`).
 */
const RE_PERIODO_NACION = /(\d{2})\/(\d{2})\/(\d{4})\s*AL\s*(\d{2})\/(\d{2})\/(\d{4})/i;

function extraerPeriodoNacion(texto: string): { readonly desde: string; readonly hasta: string } | null {
  const m = RE_PERIODO_NACION.exec(texto);
  if (!m) return null;
  const iso = (d: string, mes: string, anio: string): string => `${anio}-${mes}-${d}`;
  const primera = iso(m[1] ?? '', m[2] ?? '', m[3] ?? '');
  const segunda = iso(m[4] ?? '', m[5] ?? '', m[6] ?? '');
  // Mismo criterio que `extraerPeriodo`: se toma min/max, nunca "la primera es desde" — el orden de
  // emisión es un detalle del extractor, no una propiedad del documento.
  const desde = primera <= segunda ? primera : segunda;
  const hasta = primera <= segunda ? segunda : primera;
  if (desde === hasta) return null;
  return { desde, hasta };
}

/**
 * 🔴 **ICBC es la TERCERA rama de `leerCaratula` que necesita geometría (`aFilas`), no texto plano
 * — mismo motivo que Bancor y Nación.** Tampoco imprime ninguna etiqueta de texto libre para el
 * número de cuenta (`docs/diseno/22-formato-icbc.md` §1, hipótesis H1: la rama genérica por
 * etiqueta se probó y no matchea, ni "Número de cuenta" ni el CBU, que además viene partido en dos
 * grupos de dígitos) — están por forma y posición, mismo dato que ya resuelve el adapter
 * (`icbc.ts`, vía `fragmentoDeColumna`/regex locales).
 *
 * Ventana y regex verificadas contra el PDF real durante el Paso 1 de la construcción del adapter
 * (spec §1, H1): número (formato `dddd/dddddddd/dd`) y CBU (`C.B.U.:` + 8 dígitos + 14 dígitos, con
 * un espacio de separador) aparecen en la MISMA fila (7), en un solo fragmento geométrico —
 * exactamente un match de cada patrón dentro de las primeras 10 filas, sin ambigüedad, barrido el
 * documento completo para descartar cualquier otro candidato.
 */
const FILAS_DE_CARATULA_ICBC = 10;
const RE_NUMERO_CUENTA_ICBC = /(?<!\d)\d{4}\/\d{8}\/\d{2}(?!\d)/;
const RE_CBU_ICBC = /C\.B\.U\.:\s*(\d{8})\s+(\d{14})/i;

/**
 * 🔴 **El período de ICBC tampoco lo puede leer `extraerPeriodo` compartida** — mismo defecto que
 * ya tiene Nación (§ arriba): el conector real es `AL` en MAYÚSCULAS y `extraerPeriodo` solo acepta
 * minúsculas. Acá además el separador de fecha es GUION (`dd-mm-aaaa`), no barra — confirmado
 * contra el documento real (`docs/diseno/22-formato-icbc.md` §1.1: `PERIODO 01-06-2026 AL
 * 30-06-2026`). Mismo patrón que `RE_PERIODO` de `icbc.ts` (el adapter, ya medido y probado),
 * duplicado a propósito acá — no se toca `extraerPeriodo` compartida bajo la presión de un alta
 * real, mismo criterio ya fijado para Nación (`docs/diseno/10-deuda-declarada.md` §2.17).
 */
const RE_PERIODO_ICBC = /(\d{2})-(\d{2})-(\d{4})\s*AL\s*(\d{2})-(\d{2})-(\d{4})/i;

function extraerPeriodoIcbc(texto: string): { readonly desde: string; readonly hasta: string } | null {
  const m = RE_PERIODO_ICBC.exec(texto);
  if (!m) return null;
  const iso = (d: string, mes: string, anio: string): string => `${anio}-${mes}-${d}`;
  const primera = iso(m[1] ?? '', m[2] ?? '', m[3] ?? '');
  const segunda = iso(m[4] ?? '', m[5] ?? '', m[6] ?? '');
  const desde = primera <= segunda ? primera : segunda;
  const hasta = primera <= segunda ? segunda : primera;
  if (desde === hasta) return null;
  return { desde, hasta };
}

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
 * solo, hace falta un `cbuManual` explícito (que la CLI real obtiene con un prompt interactivo oculto,
 * nunca por argumento — ver la cabecera del archivo).
 *
 * Sin esto, un CBU mal atribuido no solo es plausible: `altaDeCuentaBancaria` es idempotente por
 * `(cliente_id, pepper_id, cbu_hmac, vigente_desde)`, así que dar de alta la cuenta en dólares DESPUÉS de
 * la de pesos, con el mismo CBU (mal) leído y el mismo período, no fallaría ni crearía nada nuevo —
 * devolvería en silencio los ids de la cuenta en pesos ya cargada, y el CLI imprimiría "Alta OK" como si
 * hubiera registrado la cuenta en dólares.
 *
 * **Multi-cuenta (Macro), tres cuentas y DOS ejes (HANDOFF (38)).** Distinto de Santander: acá el CBU SÍ
 * está atado a una sección (cada una imprime la suya, `RE_CBU_MACRO`), así que no hace falta ningún
 * prompt manual. Pero `moneda` sola no siempre alcanza para elegir sección — el caso real tiene DOS
 * cuentas en ARS de tipo distinto. `tipoManual` (el `--tipo` de la CLI) es el segundo eje, obligatorio
 * solo cuando `moneda` sola encuentra más de una candidata.
 *
 * 🔴 **Acá el riesgo es más silencioso que en Santander.** Con dos CBU reales y distintos por sección,
 * un `--tipo` equivocado no choca contra nada — el alta sale "OK" sobre la cuenta incorrecta, sin
 * excepción ni conflicto de idempotencia (`seguridad-datos-financieros`, HANDOFF (38), severidad
 * crítica). Por eso el mensaje de ambigüedad muestra tipo **y cantidad de movimientos** de cada
 * candidata — nunca solo el tipo, que es un eco circular si el operador ya tiene el mapeo mental
 * equivocado de qué tipo corresponde a qué cuenta real.
 */
export function leerCaratula(
  texto: TextoDelPdf,
  moneda: 'ARS' | 'USD',
  cbuManual: string | undefined,
  tipoManual: TipoCuentaAlta | undefined = undefined,
  /**
   * Solo Bancor, Nación e ICBC la necesitan (ver las notas de `FILAS_DE_CARATULA_BANCOR`/
   * `FILAS_DE_CARATULA_NACION`/`FILAS_DE_CARATULA_ICBC` más arriba) — opcional y `[]` por default
   * para que las otras ramas, y todos los tests que ya existían antes de Bancor, no tengan que
   * cambiar su firma de llamada.
   */
  filasGeometricas: readonly FilaGeometrica[] = [],
): {
  readonly cbu: string;
  readonly numero: string;
  readonly tipoCuenta: TipoCuentaAlta;
  readonly desde: string;
  readonly seccionUsada: string;
} {
  const lineas = aLineas(texto).map((l) => l.texto);
  const seccionadoMacro = seccionesPorClave(lineas, claveDeSeccionMacro);
  const cabecerasCuenta = lineas.filter((l) => RE_CABECERA_CUENTA.test(l));
  const esBancor = reconoceBancor(filasGeometricas);
  const esNacion = reconoceNacion(filasGeometricas);
  const esICBC = reconoceICBC(filasGeometricas);

  let numero: string;
  let tipoCuenta: TipoCuentaAlta;
  let seccionUsada: string;
  let cbuAtribuido: string | undefined;

  if (seccionadoMacro.secciones.length > 0) {
    const infoSecciones = seccionadoMacro.secciones.map((seccion) => {
      const titulo = RE_SECCION_MACRO.exec(lineas[seccion.indiceApertura] ?? '')?.[1] ?? 'CUENTA';
      return {
        seccion,
        tipo: tipoDeCuentaDelTituloMacro(titulo),
        moneda: monedaDelTituloMacro(titulo),
      };
    });

    const candidatasPorMoneda = infoSecciones.filter((s) => s.moneda === moneda);
    if (candidatasPorMoneda.length === 0) {
      throw new Error(
        `No encontré ninguna cuenta en ${moneda} en la carátula (formato Macro, ` +
          `${infoSecciones.length} cuenta(s) en el documento en total). Verificá --moneda.`,
      );
    }

    const candidatas =
      tipoManual === undefined
        ? candidatasPorMoneda
        : candidatasPorMoneda.filter((s) => s.tipo === tipoManual);

    if (candidatas.length === 0) {
      // tipoManual no matcheó ninguna de las candidatas por moneda — listar lo que sí hay, mismo criterio
      // de evidencia no circular que el caso de abajo (seguridad-datos-financieros, HANDOFF (38)).
      const detalle = candidatasPorMoneda
        .map((c) => `${c.tipo} (${contarMovimientosMacro(c.seccion, lineas)} movimiento(s))`)
        .join(', ');
      throw new Error(
        `No encontré ninguna cuenta en ${moneda} de tipo ${tipoManual} en la carátula. Las cuentas en ` +
          `${moneda} que sí hay: ${detalle}.`,
      );
    }

    if (candidatas.length > 1) {
      /**
       * 🔴 Tipo y cantidad de movimientos, nunca solo el tipo (`seguridad-datos-financieros`, HANDOFF
       * (38)): el tipo solo es un eco circular si el operador ya tiene el mapeo mental equivocado de
       * cuál tipo corresponde a cuál cuenta real. El conteo es evidencia independiente, contrastable
       * contra lo que el operador ya sabe del extracto — y no es un identificador ni un dato sensible.
       */
      const detalle = candidatas
        .map((c) => `${c.tipo} (${contarMovimientosMacro(c.seccion, lineas)} movimiento(s))`)
        .join(', ');
      throw new Error(
        `Encontré ${candidatas.length} cuentas en ${moneda}` +
          (tipoManual === undefined ? '' : ` de tipo ${tipoManual}`) +
          ` en la carátula: ${detalle}. Pasá --tipo <${TIPOS_PARA_DESAMBIGUAR.join('|')}> para elegir.`,
      );
    }

    // Sano por construcción: los dos throws de arriba ya descartaron 0 y >1 elementos.
    const elegida = candidatas[0] as (typeof candidatas)[number];

    /**
     * 🔴 El CBU real de Macro trae guiones (`#######-#-#############-#`) — se limpia y se valida acá,
     * antes de aceptarlo, con el mismo criterio de "fallar ruidoso ante una forma sin validar" que ya
     * aplica el resto del archivo (`tech-lead`, HANDOFF (38)).
     */
    const cbuCrudo = elegida.seccion.indices
      .map((i) => RE_CBU_MACRO.exec(lineas[i] ?? '')?.[1])
      .find((v): v is string => v !== undefined);
    const cbuLimpio = cbuCrudo?.replace(/\D/g, '');
    if (cbuLimpio === undefined || !/^\d{22}$/.test(cbuLimpio)) {
      throw new Error(
        'No encontré un CBU válido (22 dígitos) en la sección elegida de la carátula (formato Macro).',
      );
    }

    numero = elegida.seccion.clave;
    tipoCuenta = elegida.tipo;
    cbuAtribuido = cbuLimpio;
    seccionUsada = `Macro — ${elegida.tipo} en ${moneda}`;
  } else if (cabecerasCuenta.length > 0) {
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
            'atribuir a una sola moneda — mismo criterio que packages/ingesta/src/adaptadores/santander.ts.',
        );
      }
      cbuAtribuido = cbuManual;
    }
  } else if (esBancor) {
    // Una sola cuenta, sin ambigüedad de moneda ni de tipo (spec Bancor, `20-formato-bancor.md` §2):
    // no hace falta `moneda`/`tipoManual` para elegir nada, a diferencia de Macro/Santander.
    //
    // 🔴 Geometría (`aFilas`), no texto de línea (`aLineas`) — ver la nota de `FILAS_DE_CARATULA_BANCOR`
    // más arriba sobre por qué esta rama es la única excepción. Se busca por FRAGMENTO (no por fila
    // unida): mismo criterio que `bancor.ts::leerNumeroDeCuentaBancor`/`leerCbuBancor`, porque el
    // número y el CBU son cada uno su propio fragmento geométrico, sin texto pegado al lado.
    const fragmentosDeCaratula = filasGeometricas
      .slice(0, FILAS_DE_CARATULA_BANCOR)
      .flatMap((f) => f.fragmentos);

    const numeroEncontrado = fragmentosDeCaratula
      .map((f) => RE_NUMERO_CUENTA_BANCOR.exec(f.texto)?.[0])
      .find((v): v is string => v !== undefined);
    if (!numeroEncontrado) {
      throw new Error(
        'No encontré el número de cuenta (formato NNNNN/NN) en la carátula (Bancor). Bancor no lo ' +
          'imprime con etiqueta — revisá que el archivo sea la primera página del resumen.',
      );
    }
    const cbuEncontrado = fragmentosDeCaratula
      .map((f) => RE_CBU_BANCOR.exec(f.texto)?.[0])
      .find((v): v is string => v !== undefined);
    if (!cbuEncontrado) {
      throw new Error(
        'No encontré el CBU (22 dígitos) en la carátula (Bancor). Bancor no lo imprime con etiqueta ' +
          '"CBU" — revisá que el archivo sea la primera página del resumen.',
      );
    }

    numero = numeroEncontrado;
    tipoCuenta = 'cuenta_corriente';
    cbuAtribuido = cbuEncontrado;
    seccionUsada = 'Bancor (cuenta única, por forma geométrica en la carátula)';
  } else if (esNacion) {
    // Una sola cuenta, sin ambigüedad de moneda ni de tipo (spec Nación, `21-formato-nacion.md` §2):
    // no hace falta `moneda`/`tipoManual` para elegir nada, mismo caso que Bancor.
    //
    // 🔴 Geometría (`aFilas`), no texto de línea (`aLineas`) — ver la nota de
    // `FILAS_DE_CARATULA_NACION` más arriba. Se busca por FRAGMENTO (no por fila unida): mismo
    // criterio que `nacion.ts`, porque el número y el CBU son cada uno su propio fragmento
    // geométrico, sin texto pegado al lado.
    const fragmentosDeCaratula = filasGeometricas
      .slice(0, FILAS_DE_CARATULA_NACION)
      .flatMap((f) => f.fragmentos);

    /**
     * 🔴 **Hallazgo de `tester`: sin chequeo de ambigüedad, esto era exactamente el riesgo que la
     * cabecera del archivo prohíbe** ("dar de alta una cuenta con el identificador de un tercero").
     * `.find()` toma el PRIMER match sin verificar si hay un segundo — un decoy de 10 dígitos
     * (código de sucursal, teléfono, número de comprobante) antes del dato real en la ventana
     * ganaría en silencio, sin ninguna señal. Mismo criterio de "listar, nunca elegir el más
     * cercano" que ya usan las ramas Macro/Santander para sus propias candidatas: se deduplican
     * valores idénticos (`new Set`, un mismo número repetido no es ambigüedad) y se falla ruidoso
     * si sobrevive más de uno — nunca se adivina cuál es el real.
     */
    const numerosEncontrados = [
      ...new Set(
        fragmentosDeCaratula
          .map((f) => RE_NUMERO_CUENTA_NACION.exec(f.texto)?.[0])
          .filter((v): v is string => v !== undefined),
      ),
    ];
    if (numerosEncontrados.length === 0) {
      throw new Error(
        'No encontré el número de cuenta (10 dígitos) en la carátula (Nación). Nación no lo ' +
          'imprime con etiqueta — revisá que el archivo sea la primera página del resumen.',
      );
    }
    if (numerosEncontrados.length > 1) {
      throw new Error(
        `Encontré ${numerosEncontrados.length} valores distintos con forma de número de cuenta ` +
          '(10 dígitos) en la carátula (Nación) — no puedo elegir uno solo sin arriesgar tomar el ' +
          'de un tercero. Revisá el archivo.',
      );
    }
    const numeroEncontrado = numerosEncontrados[0] as string;

    const cbusEncontrados = [
      ...new Set(
        fragmentosDeCaratula
          .map((f) => RE_CBU_NACION.exec(f.texto)?.[0])
          .filter((v): v is string => v !== undefined),
      ),
    ];
    if (cbusEncontrados.length === 0) {
      throw new Error(
        'No encontré el CBU (22 dígitos) en la carátula (Nación). Nación no lo imprime con ' +
          'etiqueta "CBU" — revisá que el archivo sea la primera página del resumen.',
      );
    }
    if (cbusEncontrados.length > 1) {
      throw new Error(
        `Encontré ${cbusEncontrados.length} valores distintos con forma de CBU (22 dígitos) en la ` +
          'carátula (Nación) — no puedo elegir uno solo sin arriesgar tomar el de un tercero. ' +
          'Revisá el archivo.',
      );
    }
    const cbuEncontrado = cbusEncontrados[0] as string;

    numero = numeroEncontrado;
    tipoCuenta = 'cuenta_corriente';
    cbuAtribuido = cbuEncontrado;
    seccionUsada = 'Nación (cuenta única, por forma geométrica en la carátula)';
  } else if (esICBC) {
    // Una sola cuenta, sin ambigüedad de moneda ni de tipo (spec ICBC, `22-formato-icbc.md` §1):
    // no hace falta `moneda`/`tipoManual` para elegir nada, mismo caso que Bancor/Nación.
    //
    // 🔴 Geometría (`aFilas`), no texto de línea (`aLineas`) — ver la nota de
    // `FILAS_DE_CARATULA_ICBC` más arriba. Se busca por FRAGMENTO: a diferencia de Bancor/Nación,
    // acá el número Y el CBU viven en el MISMO fragmento geométrico (spec §1, H1: "N°
    // ####/########/## C.B.U.: ######## ##############" es un solo fragmento de `pdf.js`) — no
    // cambia el mecanismo de búsqueda (los dos regex se prueban contra cada fragmento igual), pero
    // en la práctica los dos matches van a salir del mismo elemento del arreglo.
    const fragmentosDeCaratula = filasGeometricas
      .slice(0, FILAS_DE_CARATULA_ICBC)
      .flatMap((f) => f.fragmentos);

    // Mismo chequeo de ambigüedad que ya corrigió el hallazgo de `tester` en la rama Nación —
    // escrito desde el día uno acá, no como un fix posterior: se deduplican valores idénticos y se
    // falla ruidoso si sobrevive más de uno, nunca se elige el primero.
    const numerosEncontrados = [
      ...new Set(
        fragmentosDeCaratula
          .map((f) => RE_NUMERO_CUENTA_ICBC.exec(f.texto)?.[0])
          .filter((v): v is string => v !== undefined),
      ),
    ];
    if (numerosEncontrados.length === 0) {
      throw new Error(
        'No encontré el número de cuenta (formato NNNN/NNNNNNNN/NN) en la carátula (ICBC). ICBC no ' +
          'lo imprime con etiqueta de texto — revisá que el archivo sea la primera página del resumen.',
      );
    }
    if (numerosEncontrados.length > 1) {
      throw new Error(
        `Encontré ${numerosEncontrados.length} valores distintos con forma de número de cuenta en ` +
          'la carátula (ICBC) — no puedo elegir uno solo sin arriesgar tomar el de un tercero. ' +
          'Revisá el archivo.',
      );
    }
    const numeroEncontrado = numerosEncontrados[0] as string;

    /**
     * 🔴 El CBU de ICBC viene PARTIDO en dos grupos de dígitos (8 + 14), a diferencia de Bancor/
     * Nación (una sola corrida de 22) — spec §1, H1. `RE_CBU_ICBC` captura los dos grupos por
     * separado; se concatenan DESPUÉS de la deduplicación, sobre el par completo (`${g1}:${g2}`
     * como clave de unicidad, no el CBU ya unido) para que dos fragmentos que compartan el primer
     * grupo pero difieran en el segundo no colapsen a un falso "sin ambigüedad".
     */
    const cbusEncontrados = [
      ...new Map(
        fragmentosDeCaratula
          .map((f) => RE_CBU_ICBC.exec(f.texto))
          .filter((m): m is RegExpExecArray => m !== null)
          .map((m) => [`${m[1]}:${m[2]}`, `${m[1]}${m[2]}`] as const),
      ).values(),
    ];
    if (cbusEncontrados.length === 0) {
      throw new Error(
        'No encontré el CBU (etiqueta "C.B.U.:" + 8 dígitos + 14 dígitos) en la carátula (ICBC) — ' +
          'revisá que el archivo sea la primera página del resumen.',
      );
    }
    if (cbusEncontrados.length > 1) {
      throw new Error(
        `Encontré ${cbusEncontrados.length} valores distintos con forma de CBU en la carátula ` +
          '(ICBC) — no puedo elegir uno solo sin arriesgar tomar el de un tercero. Revisá el archivo.',
      );
    }
    const cbuEncontrado = cbusEncontrados[0] as string;

    numero = numeroEncontrado;
    tipoCuenta = 'cuenta_corriente';
    cbuAtribuido = cbuEncontrado;
    seccionUsada = 'ICBC (cuenta única, por forma geométrica en la carátula)';
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

  // Nación: conector "AL" en mayúsculas, `extraerPeriodo` compartida no lo matchea (ver la nota de
  // `RE_PERIODO_NACION` más arriba) — usa su propia extracción, duplicada a propósito.
  const periodo = esNacion
    ? extraerPeriodoNacion(lineas.join(SALTO))
    : esICBC
      ? extraerPeriodoIcbc(lineas.join(SALTO))
      : extraerPeriodo(lineas.join(SALTO));
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
// Prompt oculto de CBU — HANDOFF (36). Ver la cabecera del archivo: `--cbu` no existe como argumento.
// La maquinaria genérica vive en `./prompt-oculto.ts` (extraída para reusarla en `alta-socio.ts`).
// -----------------------------------------------------------------------------

/**
 * Pide el CBU dos veces y exige que coincidan byte a byte antes de aceptarlo. Wrapper de
 * `pedirValorConfirmado` (`prompt-oculto.ts`) con los mensajes y la validación de forma propios del
 * CBU (22 dígitos) — la validación de forma queda del lado del llamador, mismo criterio que se usa
 * para el CUIT/CUIL en `alta-socio.ts`.
 */
export async function pedirCbuConfirmado(
  entrada: EntradaOculta = process.stdin,
  salida: SalidaOculta = process.stdout,
): Promise<string> {
  const valor = await pedirValorConfirmado(
    {
      primero: '  CBU (22 dígitos): ',
      segundo: '  Repetí el CBU para confirmar: ',
      aviso: [
        'Este documento tiene más de una cuenta y el CBU no se puede atribuir a una sola moneda.',
        'Se pide acá, tecleado, para que nunca quede en el historial de la terminal.',
        'No lo copies ni lo pegues de ningún chat, ticket, captura ni asistente de IA — tipealo directo.',
        // Aclaración agregada tras un caso real (HANDOFF (37)): sin esto, un operador que tipea el
        // CBU y no ve NADA reaccionar en pantalla no tiene forma de distinguir "está funcionando" de
        // "se colgó".
        'No vas a ver NADA en pantalla mientras tipeás — ni un asterisco, a propósito. Escribí los 22 ' +
          'dígitos igual y apretá Enter; después va a aparecer un segundo pedido para confirmarlo.',
      ],
    },
    entrada,
    salida,
  );
  if (!/^\d{22}$/.test(valor)) {
    throw new Error('El CBU tiene que ser de 22 dígitos.');
  }
  return valor;
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
  // Solo las ramas Bancor y Nación de `leerCaratula` la usan (ver las notas junto a
  // `FILAS_DE_CARATULA_BANCOR`/`FILAS_DE_CARATULA_NACION`) — se computa siempre, es barato, y así
  // ninguna de las dos llamadas de abajo se olvida de pasarla.
  const filasGeometricas = await aFilas(contenido);

  /**
   * Primer intento sin CBU manual. Si la carátula tiene una sola cuenta, esto alcanza y nunca se pide
   * nada por prompt. Si tiene más de una, `leerCaratula` tira el error puntual de "no se puede atribuir
   * a una sola moneda" — se atrapa ACÁ, y solo esa condición, para pedir el CBU de forma oculta. Cualquier
   * otro error (número de cuenta, período, etc.) sigue de largo sin pasar por el prompt.
   */
  let caratula: ReturnType<typeof leerCaratula>;
  let cbuFueManual = false;
  try {
    caratula = leerCaratula(texto, args.moneda, undefined, args.tipo, filasGeometricas);
  } catch (error) {
    const esAmbiguedadDeCbu =
      error instanceof Error && error.message.includes('no se puede atribuir a una sola moneda');
    if (!esAmbiguedadDeCbu) throw error;
    try {
      const cbuManual = await pedirCbuConfirmado();
      caratula = leerCaratula(texto, args.moneda, cbuManual, args.tipo, filasGeometricas);
      cbuFueManual = true;
    } catch (errorDePrompt) {
      const mensaje = errorDePrompt instanceof Error ? errorDePrompt.message : 'error desconocido';
      imprimir(`  ABORTA: ${mensaje}`);
      process.exit(1);
    }
  }

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
          /**
           * Los dos sufijos los agrega la CLI, nunca el operador — así "¿este CBU se leyó del extracto o
           * lo tipeó alguien?" y "¿esta cuenta se leyó sin ambigüedad, o dependió de que el operador
           * eligiera entre variantes reales?" quedan contestables desde `acceso_auditoria` sin depender
           * de que quien dio de alta se haya acordado de anotrarlo (`seguridad-datos-financieros`,
           * HANDOFF (36) para el primero, HANDOFF (38) para el segundo). Ninguno lleva el CBU ni el
           * número de cuenta — el primero solo dice procedencia, el segundo solo el tipo elegido (N1, no
           * sensible).
           */
          motivo:
            `alta de cuenta ${args.banco} desde la caratula del resumen, piloto Modulo 1` +
            (cbuFueManual ? ' — CBU ingresado manualmente por el operador, no leido del documento' : '') +
            (args.tipo === undefined
              ? ''
              : ` — el operador especifico --tipo=${args.tipo} para elegir la seccion (formato Macro)`),
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
