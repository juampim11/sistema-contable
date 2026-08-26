/**
 * Extractor PRELIMINAR de posiciones de FCI desde el extracto de Santander — mismo criterio de
 * "preliminar, no adapter oficial" que `fci-galicia/extraer-posiciones.ts` (sin `contrato.ts`/
 * `esquema.ts`/`persistir.ts`), layout DISTINTO del de Galicia: confirmado por descubrimiento
 * estructural (el patrón literal de Galicia, `FONDO - <nombre> CLASE <letra>`, dio 0 matches) más
 * revisión visual del titular (E-5, `docs/seguridad/registro-excepciones.md` — nunca un valor real
 * llegó a este código, solo forma).
 *
 * 🔴 **Identidad del titular del documento de origen: RESUELTA — Pannonica SAS** (addendum E-5,
 * 2026-08-25, `docs/seguridad/registro-excepciones.md`). El encuadre original de la tarea asumía "El
 * Prat S.A.S." por error, nunca verificado contra la carátula real; corregido. Este módulo es
 * genérico — no referencia ningún nombre de cliente ni tenant, ni de El Prat ni de Pannonica — y por
 * eso no necesitó ningún cambio de código con la corrección de atribución. **Confirmado 2026-08-25:
 * Pannonica SAS NO tiene tenant dado de alta en el piloto** (0 coincidencias contra `tenant_node`,
 * lectura de solo consulta) — bloquea persistir o generar el `.xlsx` de entrega hasta que se dé de
 * alta como cliente nuevo; no bloquea este extractor en sí.
 *
 * ## Layout confirmado (por el titular, mirando el documento real — nunca un valor, solo forma)
 *
 * Cada fondo trae un encabezado propio `Fondo: <nombre>` (+ `Moneda: ARS`, sin usarse acá) — SIN
 * prefijo de plantilla fijo como el `FONDO - ... CLASE ...` de Galicia; el nombre va directo después
 * de la etiqueta. Debajo, dos filas de saldo (`SALDO INICIAL` / `SALDO FINAL`), y entre ambas las
 * filas de movimiento: `Fecha | Concepto | Certificado | Cantidad | Valor | Importe` — mismas
 * columnas conceptuales que Galicia (fecha/tipo/cantidad/precio/importe) más una columna nueva sin
 * equivalente ahí. Las 3 tablas (una por fondo) son visualmente idénticas en estructura — confirmado
 * por el titular con captura de pantalla.
 *
 * ## Fuente ÚNICA: `pdftotext -layout` (Poppler) — por qué se abandonó `unpdf`
 *
 * Una primera versión de este extractor usaba `unpdf`/`pdf.js` (`../texto-pdf.ts`, la fuente del
 * resto del Módulo 1) para TODO: geometría, etiquetas y valores. Se abandonó por completo, con
 * evidencia real en cada paso — resumen, detalle completo en
 * `docs/diseno/19-fci-santander-extractor-hibrido.md`:
 *
 * 1. **Etiquetas y números viven en zonas de `y` disjuntas** en este documento (`y ∈ [50,327]` las
 *    etiquetas, `y ∈ [468,708]` los números — cero superposición). Descarta agrupar por proximidad
 *    geométrica, como hace Galicia.
 * 2. **`unpdf` pierde palabras puntuales** — SALDO/INICIAL/FINAL (encuentra 1 de 6), Fondo (2 de 3),
 *    SUSCRIP/RESCATE (0 de 6) — por un problema de decodificación de fuente/glifo no aislado con
 *    precisión (`fontName` de `pdf.js`: 2 fuentes, ninguna falla al 100%, 79%/51% de acierto cada
 *    una). `pdftotext` (Poppler) no tiene ninguno de estos dos problemas: reconstruye cada fila como
 *    una única línea de texto, con las palabras completas y en su posición visual real.
 * 3. **Intento intermedio — cola numérica secuencial de `unpdf`, emparejada por SECUENCIA con las
 *    etiquetas de `pdftotext`** (dos fuentes, cada una para lo suyo): la ESTRUCTURA (qué fila es de
 *    qué fondo, de qué tipo, en qué orden) salió perfecta — verificada contra el conteo real del
 *    titular, exacto. Pero la ARITMÉTICA no cerraba en NINGÚN fondo. Medido: ni siquiera el `Importe`
 *    de las filas de SALDO (un valor sin ambigüedad posible) tenía una forma consistente entre sí
 *    (mezcla de 2 y 4 decimales, seis posiciones de `x` todas distintas) — la cola plana ordenada por
 *    `(y, x)` de `unpdf` NO reconstruye correctamente qué número pertenece a qué fila real en la zona
 *    numérica de este documento. No es un problema de qué orden asumir dentro de una fila: es que la
 *    cola ni siquiera agrupa bien las filas.
 *
 * **La solución: pdftotext -layout da la línea completa, ya alineada por columnas** (con espaciado
 * consistente) — no hace falta reconstruir nada por coordenadas. Partiendo cada línea por 2+ espacios
 * consecutivos (`camposDeLinea`), cada campo resultante se identifica por su FORMA, nunca por
 * posición: `Cantidad` tiene 4 decimales, `Valor` 6, `Importe` 2 — tres cantidades de decimales
 * DISTINTAS, sin ambigüedad, medido contra una línea de movimiento real. `Certificado` es el único
 * campo de 7 dígitos sin coma. El orden físico de columnas (Certificado antes o después de Cantidad,
 * por ejemplo) queda irrelevante — se identifica por forma, no por posición.
 *
 * `unpdf` queda **fuera de este extractor por ahora** — no como cruce opcional activo (se probó y no
 * daba información real: las tres categorías fallaban por el mismo motivo de fondo, un cruce
 * garantizado a fallar es peor que no cruzar nada). Si la causa de decodificación de fuente de
 * `pdf.js` se identifica y arregla más adelante, reincorporarlo como verificación cruzada es una
 * mejora futura — no bloquea este extractor mientras tanto.
 *
 * 🔴 **Dependencia externa nueva, no gestionada por `pnpm`**: requiere el binario `pdftotext`,
 * **específicamente la build de Poppler** — confirmado en esta misma tarea que xpdf (Glyph & Cog,
 * mismo nombre de comando, proyecto de código DISTINTO) produce resultados de `-layout`
 * estructuralmente distintos para el mismo PDF real. `verificarBuildDePdftotext` aborta explícito si
 * el binario del `PATH` no se identifica como Poppler, en vez de correr silenciosamente contra la
 * build equivocada. Ver ADR-0000 §2.4 (licencias: Poppler es GPL, usado solo como subproceso) y
 * `docs/devops/01-entornos.md` §3.bis (instalación).
 *
 * ## Consecuencia real, no un detalle de implementación: acá el Eje 1 es de IMPORTE, no de CANTIDAD
 *
 * Galicia declara la tenencia (cantidad de cuotapartes) al cierre, y su Eje 1 compara cantidades.
 * Santander NO declara ninguna cantidad en sus filas de saldo — solo importe. El invariante que este
 * extractor puede alimentar es, entonces, uno **de caja**: `saldoInicialImporte +
 * Σimporte(suscripciones) − Σimporte(rescates) = saldoFinalImporte`. La aritmética es EXACTAMENTE la
 * misma que `verificarPosicionFondo` (`../fci-galicia/verificar-posicion.ts`) ya implementa — es solo
 * suma y resta de decimales sin signo, no le importa la unidad — así que ese verificador se REUSA tal
 * cual, pasándole importes en vez de cantidades. No es el mismo invariante de negocio que el Eje 1 de
 * Galicia y no debe confundirse con él al reportar el resultado.
 *
 * ## Consecuencia sobre el Eje 2 (`consumirRescate`, PEPS): bloqueado salvo saldo inicial CERO
 *
 * `consumirRescate` (`packages/fci`) necesita una capa de apertura con cantidad y precio conocidos (o
 * marcados explícitamente como no conocidos) para simular. Sin una CANTIDAD inicial declarada acá, no
 * hay forma de construir esa capa sin inventar un valor — prohibido en este código base. Cuando
 * `saldoInicialImporte` es CERO, no hace falta capa de apertura (el fondo no tenía tenencia previa
 * este período) y el llamador puede simular usando solo los movimientos del período. Cuando NO es
 * cero, este extractor lo señala (`pepsBloqueado: true`) y el llamador no debe intentar construir una
 * capa de apertura inventada — se documenta como límite estructural, no se fuerza.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizarTokenNumerico, parsearFecha, type Periodo } from '../parseo-ar.ts';
import { aPuntoFijo, esCero } from '@sistema-contable/fci';

const RE_FECHA = /^\d{1,2}[/\-]\d{1,2}(?:[/\-]\d{2,4})?$/;
const RE_NUMERO_AR = /^-?\d{1,3}(?:\.\d{3})*,(\d{1,6})$/;
const RE_CERTIFICADO = /^\d{7}$/;

/**
 * `Fondo: <nombre>` — SIN prefijo de plantilla fijo (a diferencia de Galicia). El grupo 1 puede
 * arrastrar `Moneda: ARS` si viene en el mismo fragmento de texto de fila; se recorta después.
 *
 * 🔴 Los dos puntos son OPCIONALES (hallazgo real de la primera corrida): con `:` obligatorio, el
 * clasificador reconocía 1 de los 3 encabezados reales del documento — los otros 2 tienen el
 * carácter `:` extraído de forma distinta (o ausente) por el mismo tipo de sustitución de fuente que
 * `docs/diseno/06-formato-santander.md` §11.12 ya documentó para este banco en otro extracto.
 * Confirmado con conteos: exigiendo `:` → 1 match; con `:` opcional → 3, igual que `/Fondo/i` sin
 * ninguna otra condición — así que el separador nunca fue necesario para localizar la etiqueta, solo
 * para separarla del nombre, y `\s*` ya alcanza para eso cuando el separador falta.
 *
 * 🔴 SIN anclaje de límite de palabra (ni `\b`, ni exigir inicio de fila o espacio antes de "Fondo").
 * Se probó `(?:^|\s)Fondo` para evitar que "SuperFondo..." (el nombre real del tercer fondo de este
 * documento) se auto-matcheara si apareciera suelto en otro lado — pero **2 de los 3 encabezados
 * reales tienen algo pegado justo antes de "Fondo" sin espacio, dentro del mismo fragmento de
 * texto**. Con el anclaje, el clasificador solo reconocía 1 de 3; sacándolo, reconoce los 3 — medido
 * contra el documento real. El riesgo de "SuperFondo" suelto en otro punto del documento (sin la
 * etiqueta "Fondo:" propia) queda cubierto por el guard de longitud de `comoEncabezadoDeFondo` (un
 * nombre de fondo real no pasa de ~30 caracteres; una mención suelta dentro de una oración normalmente
 * sí), no por un anclaje de posición.
 */
const RE_ENCABEZADO_FONDO = /Fondo\s*[:\-–—]?\s*(.+)/i;
const RE_SALDO_INICIAL = /SALDO\s+INICIAL/i;
const RE_SALDO_FINAL = /SALDO\s+FINAL/i;
const RE_TIPO_SUSCRIPCION = /SUSCRIP/i;
const RE_TIPO_RESCATE = /RESCATE/i;

function sinPrefijoDeMoneda(texto: string): string {
  return texto.replace(/^-?\s*(?:U\$S|\$)\s*/, (coincidencia) => (coincidencia.startsWith('-') ? '-' : ''));
}

/** AR (`"1.234,56"`, con o sin prefijo de moneda) a decimal canónico (`"1234.56"`). Nunca trunca. */
function aTextoCanonico(texto: string): string {
  const sinMoneda = sinPrefijoDeMoneda(normalizarTokenNumerico(texto));
  return sinMoneda.replace(/\./g, '').replace(',', '.');
}

/** Cantidad de decimales de un campo con forma numérica AR (despegando el prefijo de moneda ANTES de
 *  testear, no solo antes de convertir — bug real atrapado por un test propio: `"$ 1.000,00"` no
 *  matchea `RE_NUMERO_AR` directo), o `null` si el campo no tiene esa forma. */
function decimalesDeCampoNumerico(campo: string): number | null {
  const m = RE_NUMERO_AR.exec(sinPrefijoDeMoneda(normalizarTokenNumerico(campo)).trim());
  return m?.[1] ? m[1].length : null;
}

/** Mismo criterio que `fci-galicia/extraer-posiciones.ts`: colapsa espacios, preserva mayúsculas. */
export function nombreFondoExpuestoSantander(nombreCrudo: string): string {
  return nombreCrudo
    .replace(/\s+Moneda\s*:.*/i, '')
    .trim()
    .replace(/\s+/g, ' ');
}

export type MovimientoFciSantander = {
  readonly tipo: 'suscripcion' | 'rescate';
  readonly cantidad: string;
  readonly precio: string;
  readonly importe: string;
  /** 7 dígitos, string tal cual (nunca se opera aritméticamente sobre esto). Vacío si no se detectó. */
  readonly certificado: string;
  readonly fecha: string;
};

export type FondoExtraidoSantander = {
  readonly fondo: string;
  readonly saldoInicialImporte: string;
  readonly saldoFinalImporte: string;
  /** En ORDEN de documento, validado monótono por `fecha` — igual criterio que Galicia. */
  readonly movimientos: readonly MovimientoFciSantander[];
  readonly movimientosConfiables: boolean;
  /** Importes (NO cantidades) — para el Eje 1 de caja. Directo de las filas crudas, nunca a través de
   *  `movimientos`, mismo criterio que Galicia: un problema de fecha no debe tumbar este cálculo. */
  readonly importesSuscripciones: readonly string[];
  readonly importesRescates: readonly string[];
  readonly pepsBloqueado: boolean;
  readonly pepsBloqueadoMotivo: 'saldo_inicial_no_cero_sin_cantidad_declarada' | null;
};

export type ExtraccionPosicionFciSantander = {
  readonly fondos: readonly FondoExtraidoSantander[];
};

/** El orden de `movimientos`, resuelto por fecha, no resultó monótono no decreciente — mismo criterio
 *  que Galicia: nunca se reordena en silencio, se descarta el campo entero para ese fondo. */
export class OrdenMovimientoInvalidoError extends Error {
  constructor() {
    super('El orden de los movimientos, resuelto por fecha, no es monótono no decreciente.');
    this.name = 'OrdenMovimientoInvalidoError';
  }
}

/** La fecha de un movimiento no se pudo resolver contra el `periodo` del corte — nunca se adivina. */
export class FechaMovimientoInvalidaError extends Error {
  constructor() {
    super('La fecha de un movimiento no se pudo resolver contra el período del corte.');
    this.name = 'FechaMovimientoInvalidaError';
  }
}

/**
 * Un fondo tiene encabezado pero le falta la fila de SALDO INICIAL o SALDO FINAL — nunca se completa
 * con un valor inventado (`0`, u otra cosa): se aborta la extracción de ese documento entero, porque
 * sin las dos filas no hay Eje 1 posible para NINGÚN fondo del documento y seguir extraería datos a
 * medias que podrían leerse como "completo".
 *
 * 🔴 El mensaje NUNCA lleva el nombre de fondo extraído — mismo criterio que `ConsumoInvalidoError`
 * (`packages/fci`) y `CantidadPosicionInvalidaError` (`fci-galicia/aritmetica-posicion.ts`): un texto
 * proveniente del documento no debe viajar en un mensaje de excepción, porque ese mensaje puede
 * terminar en un log, una terminal o (como pasó una vez escribiendo este mismo extractor) en el
 * contexto de quien está depurando. Solo el ÍNDICE del fondo dentro del documento (1-based, orden de
 * aparición) — un identificador de posición, no de contenido.
 */
export class SaldoFaltanteError extends Error {
  readonly indiceDeFondo: number;
  readonly cual: 'inicial' | 'final';

  constructor(indiceDeFondo: number, cual: 'inicial' | 'final') {
    super(`Falta la fila de SALDO ${cual.toUpperCase()} para el fondo #${indiceDeFondo} del documento (por orden de aparición).`);
    this.name = 'SaldoFaltanteError';
    this.indiceDeFondo = indiceDeFondo;
    this.cual = cual;
  }
}

/**
 * Un bloque delimitado por un par SALDO INICIAL→FINAL no tiene, retrocediendo desde su SALDO INICIAL
 * hasta el final del bloque anterior (o el principio del documento, para el primero), ninguna línea
 * con un encabezado `Fondo:` reconocible — nunca se asume "es el fondo #N porque es el N-ésimo
 * bloque" sin esa confirmación textual. Identifica el número de orden del bloque (1-based), nunca el
 * contenido de las líneas.
 */
export class EncabezadoDeFondoNoEncontradoError extends Error {
  readonly numeroDeBloqueDeDatos: number;

  constructor(numeroDeBloqueDeDatos: number) {
    super(
      `El bloque #${numeroDeBloqueDeDatos} (por orden de aparición) no tiene ningún encabezado "Fondo:" ` +
        `reconocible antes de su SALDO INICIAL.`,
    );
    this.name = 'EncabezadoDeFondoNoEncontradoError';
    this.numeroDeBloqueDeDatos = numeroDeBloqueDeDatos;
  }
}

/**
 * La cantidad TOTAL de líneas con un encabezado `Fondo:` reconocible en la página 1 (desde el primer
 * bloque hasta el final del último, buscadas en cualquier posición, no solo retrocediendo desde cada
 * SALDO INICIAL) no coincide con la cantidad de bloques SALDO INICIAL→FINAL ya validados. Señal de
 * una línea "Fondo:" extra sin bloque propio, o de un bloque cuyo nombre se tomó de una línea que en
 * realidad pertenece a otro — nunca se ignora, aunque el emparejamiento backward ya haya encontrado
 * un nombre para cada bloque.
 */
export class ConsistenciaInternaPdftotextError extends Error {
  readonly conteoFondos: number;
  readonly conteoBloques: number;

  constructor(conteoFondos: number, conteoBloques: number) {
    super(
      `pdftotext encontró ${conteoFondos} línea(s) con encabezado "Fondo:" reconocible en el rango de ` +
        `los bloques, pero se armaron ${conteoBloques} bloque(s) SALDO INICIAL→FINAL — no coinciden. No ` +
        `se fuerza el resultado: hay una línea "Fondo:" de más (o de menos) sin explicar.`,
    );
    this.name = 'ConsistenciaInternaPdftotextError';
    this.conteoFondos = conteoFondos;
    this.conteoBloques = conteoBloques;
  }
}

/**
 * Un SALDO INICIAL sin su SALDO FINAL antes del próximo SALDO INICIAL (o viceversa), o un INICIAL que
 * queda abierto al final del documento — nunca se asume el peor caso en silencio: se aborta con el
 * motivo exacto. `numeroDeBloque` es 1-based, por cantidad de bloques ya cerrados + el que falló.
 */
export class SaldoDesalineadoError extends Error {
  readonly numeroDeBloque: number;
  readonly motivo: 'inicial_duplicado_sin_final_previo' | 'final_sin_inicial_previo' | 'inicial_sin_final_al_final_del_documento';

  constructor(numeroDeBloque: number, motivo: SaldoDesalineadoError['motivo']) {
    super(
      `Bloque #${numeroDeBloque}: SALDO INICIAL y SALDO FINAL no alternan correctamente (motivo: ` +
        `${motivo}) — no se fuerza ningún emparejamiento entre ellos.`,
    );
    this.name = 'SaldoDesalineadoError';
    this.numeroDeBloque = numeroDeBloque;
    this.motivo = motivo;
  }
}

/** El binario `pdftotext` del `PATH` no es una build de Poppler (o no se pudo determinar su versión)
 *  — este extractor está validado contra Poppler; otras builds (xpdf, confirmado en esta misma tarea)
 *  producen resultados de `-layout` estructuralmente distintos para el mismo PDF. Fallar alto ACÁ,
 *  antes de parsear nada, es preferible a un resultado silenciosamente incorrecto. */
export class BuildDePdftotextIncorrectaError extends Error {
  constructor() {
    super(
      'El binario "pdftotext" del PATH no parece ser una build de Poppler (no se encontró "Poppler" en ' +
        'su salida de versión). Este extractor está validado contra Poppler — otras builds (xpdf, entre ' +
        'otras) producen resultados de `-layout` estructuralmente distintos para el mismo PDF, medido en ' +
        'esta misma tarea (docs/diseno/19-fci-santander-extractor-hibrido.md). Instalar Poppler ' +
        '(docs/devops/01-entornos.md §3.bis) antes de reintentar.',
    );
    this.name = 'BuildDePdftotextIncorrectaError';
  }
}

/**
 * `pdftotext -v` — Poppler escribe el banner de versión a `stderr`, no a `stdout` (medido en esta
 * misma tarea: `execFileSync` en el camino de ÉXITO solo expone `stdout`, que queda vacío — el
 * banner real solo aparecía porque el proceso hijo heredaba la consola, nunca en el valor devuelto,
 * así que el guard fallaba en falso incluso con Poppler bien instalado). `spawnSync` (a diferencia de
 * `execFileSync`) siempre expone `stdout` Y `stderr` por separado, sin importar el código de salida
 * (Poppler y xpdf además devuelven códigos distintos de 0 para `-v`) — no hace falta `try/catch`.
 */
function salidaDeVersionDePdftotext(): string {
  const resultado = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  return `${resultado.stdout ?? ''}${resultado.stderr ?? ''}`;
}

function verificarBuildDePdftotext(): void {
  if (!/poppler/i.test(salidaDeVersionDePdftotext())) {
    throw new BuildDePdftotextIncorrectaError();
  }
}

/**
 * `Fondo: <nombre>` → el nombre expuesto, o `null` si la fila no es un encabezado de fondo real. Pura.
 *
 * 🔴 Guard agregado tras un hallazgo real de la primera corrida contra el documento real: una fila
 * cuyo "nombre" capturado queda vacío, o repite la propia etiqueta (`"Fondo:"` sin nada útil después
 * — un artefacto de layout, no un fondo con ese nombre) NO abre un fondo nuevo.
 *
 * Un nombre de fondo real, medido contra los 3 de este documento, no pasa de ~30 caracteres. Sin
 * requerir `:` (ver el comentario de `RE_ENCABEZADO_FONDO`), una fila de texto legal/prosa que
 * mencione la palabra "Fondo" en una oración larga ("...el Fondo de Garantía de los Depósitos
 * establece que...") también matchea la forma del patrón — se descarta acá por longitud, como
 * segunda defensa además del filtro de página 1 que aplica el llamador.
 */
const LARGO_MAXIMO_NOMBRE_DE_FONDO = 60;

export function comoEncabezadoDeFondo(textoDeLaLinea: string): string | null {
  const encabezado = RE_ENCABEZADO_FONDO.exec(textoDeLaLinea);
  if (!encabezado?.[1]) return null;
  const nombreCrudo = nombreFondoExpuestoSantander(encabezado[1]);
  // 🔴 Con el separador opcional (arriba), "Fondo:" sin nada después hace que el regex retroceda y
  // termine capturando el propio ":" como "nombre" (grupo 1 no puede quedar vacío por el `.+`) —
  // hallazgo de un test propio, no del documento real. Se recorta cualquier separador sobrante que
  // haya quedado al principio antes de decidir si el nombre es válido.
  const nombre = nombreCrudo.replace(/^[:\-–—\s]+/, '');
  if (nombre === '' || /^Fondo\b/i.test(nombre)) return null;
  if (nombre.length > LARGO_MAXIMO_NOMBRE_DE_FONDO) return null;
  return nombre;
}

/** `SALDO INICIAL`/`SALDO FINAL` → su tipo, o `null` si la línea no es una línea de saldo. Pura. */
export function comoEtiquetaDeSaldo(textoDeLaLinea: string): 'inicial' | 'final' | null {
  if (RE_SALDO_INICIAL.test(textoDeLaLinea)) return 'inicial';
  if (RE_SALDO_FINAL.test(textoDeLaLinea)) return 'final';
  return null;
}

/**
 * Parte una línea de `pdftotext -layout` en sus campos de columna — `-layout` alinea con espaciado
 * consistente, así que 2 o más espacios seguidos son un separador de columna real (nunca un espacio
 * simple dentro del contenido de un campo, como "SALDO INICIAL" o "27/06/2026"). Pura.
 */
export function camposDeLinea(linea: string): string[] {
  return linea
    .split(/\s{2,}/)
    .map((c) => c.trim())
    .filter((c) => c !== '');
}

/**
 * Importe de una línea de SALDO INICIAL/FINAL — el ÚNICO campo con forma numérica AR y exactamente 2
 * decimales (Certificado/Cantidad/Valor quedan vacíos en estas filas, confirmado por el titular).
 * `null` si la línea no es de saldo, o si no hay exactamente un campo con esa forma (nunca se adivina
 * cuál de varios candidatos es el correcto).
 */
export type SaldoDeLinea = { readonly tipo: 'inicial' | 'final'; readonly importe: string };

export function comoSaldoDeLinea(linea: string): SaldoDeLinea | null {
  const tipo = comoEtiquetaDeSaldo(linea);
  if (!tipo) return null;
  const candidatos = camposDeLinea(linea).filter((c) => decimalesDeCampoNumerico(c) === 2);
  if (candidatos.length !== 1) return null;
  return { tipo, importe: aTextoCanonico(candidatos[0]!) };
}

type MovimientoCrudo = {
  readonly tipo: 'suscripcion' | 'rescate';
  readonly cantidad: string;
  readonly precio: string;
  readonly importe: string;
  readonly certificado: string;
  readonly fechaCruda: string;
};

/**
 * Fila de movimiento completa, con sus 4 campos numéricos/certificado resueltos — cada uno
 * identificado por FORMA, nunca por posición de columna (ver el comentario del módulo): `Cantidad`
 * tiene 4 decimales, `Valor` 6, `Importe` 2 — medido contra una línea real, sin ambigüedad entre los
 * tres. `Certificado` es el único campo de exactamente 7 dígitos sin coma (vacío si no aparece — no
 * participa de ningún cálculo, así que su ausencia no bloquea el resto). `null` si la línea no
 * empieza con fecha, no trae SUSCRIP/RESCATE, o falta Cantidad/Valor/Importe (nunca se fuerza con lo
 * que falte).
 */
export function comoMovimientoDeLinea(linea: string): MovimientoCrudo | null {
  const primeraPalabra = linea.split(/\s+/)[0] ?? '';
  if (!RE_FECHA.test(primeraPalabra)) return null;
  const tipo = RE_TIPO_SUSCRIPCION.test(linea) ? 'suscripcion' : RE_TIPO_RESCATE.test(linea) ? 'rescate' : null;
  if (!tipo) return null;

  let cantidad: string | null = null;
  let precio: string | null = null;
  let importe: string | null = null;
  let certificado = '';

  for (const campo of camposDeLinea(linea)) {
    const decimales = decimalesDeCampoNumerico(campo);
    if (decimales !== null) {
      if (decimales === 4) cantidad = aTextoCanonico(campo);
      else if (decimales === 6) precio = aTextoCanonico(campo);
      else if (decimales === 2) importe = aTextoCanonico(campo);
      continue;
    }
    if (RE_CERTIFICADO.test(campo)) certificado = campo;
  }

  if (cantidad === null || precio === null || importe === null) return null;
  return { tipo, cantidad, precio, importe, certificado, fechaCruda: primeraPalabra };
}

type Bloque = {
  readonly nombre: string;
  readonly saldoInicialImporte: string;
  readonly saldoFinalImporte: string;
  readonly movimientosCrudos: readonly MovimientoCrudo[];
};

/**
 * Corre `pdftotext -layout <archivo temporal> -` sobre los bytes del PDF y devuelve los 3 bloques de
 * fondo YA RESUELTOS (nombre, saldos, movimientos con sus 4 campos) — fuente ÚNICA de este extractor,
 * ver el comentario del módulo para por qué se abandonó `unpdf`.
 *
 * 🔴 El binario disponible tiene que ser **Poppler**, no xpdf ni cualquier build que resuelva el
 * mismo nombre de comando (`verificarBuildDePdftotext` aborta si no). Esa build NO acepta `-` como
 * entrada por stdin de forma universal — por eso los bytes se escriben a un archivo temporal
 * (`node:os.tmpdir()`, nombre aleatorio) antes de invocar el binario, y se borra en un `finally`.
 *
 * **Segmentación por ANCLAS DE CONTENIDO (SALDO INICIAL/FINAL), no por largo de línea ni por buscar
 * "Fondo" en cualquier lado.** Dos diseños anteriores de esta misma tarea, descartados con evidencia
 * real (detalle completo: `docs/diseno/19-fci-santander-extractor-hibrido.md`):
 * 1. Buscar `comoEncabezadoDeFondo` en cada línea del documento — encontraba coincidencias de más
 *    (menciones sueltas de "Fondo" en título, texto legal de la página 2, fila de títulos repetida).
 * 2. Segmentar por LARGO de línea (`-layout` rellena cada fila a un ancho fijo) — **no es portable
 *    entre builds de `pdftotext`**: Poppler y xpdf producen longitudes de línea completamente
 *    distintas para el mismo PDF.
 *
 * `comoEtiquetaDeSaldo` (contenido, no forma) encuentra los 6 SALDO INICIAL/FINAL de forma confiable
 * — son las ANCLAS. Cada par INICIAL→FINAL consecutivo delimita un bloque (alternancia validada
 * estricta, `SaldoDesalineadoError` si no alterna); el nombre del fondo se busca retrocediendo SOLO
 * dentro de ese bloque; los movimientos son las líneas ENTRE el INICIAL y el FINAL de ese mismo
 * bloque que empiezan con fecha + SUSCRIP/RESCATE.
 *
 * **Verificación de consistencia interna** (`ConsistenciaInternaPdftotextError`): la cantidad de
 * líneas "Fondo:" en el rango que cubren los bloques tiene que coincidir con la cantidad de bloques —
 * dos maneras independientes de contar dentro de la MISMA fuente, en vez de cruzar contra `unpdf`
 * (que ya se sabe que falla en las tres categorías por el mismo motivo de fondo — ver el comentario
 * del módulo).
 */
export function extraerBloquesConPdftotext(bytes: Uint8Array): Bloque[] {
  verificarBuildDePdftotext();

  const rutaTemporal = join(tmpdir(), `fci-santander-${randomUUID()}.pdf`);
  let salida: string;
  try {
    writeFileSync(rutaTemporal, bytes);
    salida = execFileSync('pdftotext', ['-layout', rutaTemporal, '-'], { encoding: 'utf8' });
  } finally {
    rmSync(rutaTemporal, { force: true });
  }

  // `-layout` inserta un form-feed (`\f`) entre páginas por defecto — la página 1 es todo lo que hay
  // antes del primero. Mismo criterio que el resto del extractor: solo página 1 tiene datos de fondo
  // (confirmado por el titular: la página 2 es texto legal/firmas, sin ninguna tabla).
  const textoPagina1 = salida.split('\f')[0] ?? '';
  const lineas = textoPagina1
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');

  type EventoDeSaldo = { readonly indice: number; readonly tipo: 'inicial' | 'final' };
  const eventosDeSaldo: EventoDeSaldo[] = [];
  lineas.forEach((linea, indice) => {
    const tipo = comoEtiquetaDeSaldo(linea);
    if (tipo) eventosDeSaldo.push({ indice, tipo });
  });

  type ParDeIndices = { readonly indiceInicial: number; readonly indiceFinal: number };
  const pares: ParDeIndices[] = [];
  let indiceInicialAbierto: number | null = null;
  let numeroDeBloque = 0;

  for (const evento of eventosDeSaldo) {
    if (evento.tipo === 'inicial') {
      if (indiceInicialAbierto !== null) {
        throw new SaldoDesalineadoError(numeroDeBloque + 1, 'inicial_duplicado_sin_final_previo');
      }
      indiceInicialAbierto = evento.indice;
      continue;
    }
    if (indiceInicialAbierto === null) {
      throw new SaldoDesalineadoError(numeroDeBloque + 1, 'final_sin_inicial_previo');
    }
    numeroDeBloque += 1;
    pares.push({ indiceInicial: indiceInicialAbierto, indiceFinal: evento.indice });
    indiceInicialAbierto = null;
  }
  if (indiceInicialAbierto !== null) {
    throw new SaldoDesalineadoError(numeroDeBloque + 1, 'inicial_sin_final_al_final_del_documento');
  }

  // Nombre de cada bloque — retrocediendo desde su SALDO INICIAL hasta el fin del bloque anterior. Se
  // guarda también el índice donde se encontró: acota la verificación de consistencia de abajo al
  // rango real de los bloques, sin incluir el preámbulo del documento (título, membrete).
  type ParConNombre = ParDeIndices & { readonly nombreDeFondo: string; readonly indiceDelNombre: number };
  const paresConNombre: ParConNombre[] = [];
  let finDelBloqueAnterior = 0;

  pares.forEach((par, indiceDeBloque) => {
    let nombreDeFondo: string | null = null;
    let indiceDelNombre: number | null = null;
    for (let i = par.indiceInicial - 1; i >= finDelBloqueAnterior; i -= 1) {
      const candidato = comoEncabezadoDeFondo(lineas[i]!);
      if (candidato !== null) {
        nombreDeFondo = candidato;
        indiceDelNombre = i;
        break;
      }
    }
    if (nombreDeFondo === null || indiceDelNombre === null) {
      throw new EncabezadoDeFondoNoEncontradoError(indiceDeBloque + 1);
    }
    paresConNombre.push({ ...par, nombreDeFondo, indiceDelNombre });
    finDelBloqueAnterior = par.indiceFinal + 1;
  });

  const indiceDesde = paresConNombre[0]!.indiceDelNombre;
  const indiceHasta = pares[pares.length - 1]!.indiceFinal;
  const totalLineasConFondo = lineas
    .slice(indiceDesde, indiceHasta + 1)
    .filter((l) => comoEncabezadoDeFondo(l) !== null).length;
  if (totalLineasConFondo !== pares.length) {
    throw new ConsistenciaInternaPdftotextError(totalLineasConFondo, pares.length);
  }

  // Armado final: para cada bloque, resolver el importe de sus dos filas de saldo y los 4 campos de
  // cada línea de movimiento — todo desde el CONTENIDO de la línea, nunca por posición geométrica.
  return paresConNombre.map(({ nombreDeFondo, indiceInicial, indiceFinal }, indiceDeBloque) => {
    const saldoInicial = comoSaldoDeLinea(lineas[indiceInicial]!);
    const saldoFinal = comoSaldoDeLinea(lineas[indiceFinal]!);
    if (!saldoInicial) throw new SaldoFaltanteError(indiceDeBloque + 1, 'inicial');
    if (!saldoFinal) throw new SaldoFaltanteError(indiceDeBloque + 1, 'final');

    const movimientosCrudos: MovimientoCrudo[] = [];
    for (let i = indiceInicial + 1; i < indiceFinal; i += 1) {
      const movimiento = comoMovimientoDeLinea(lineas[i]!);
      if (movimiento) movimientosCrudos.push(movimiento);
    }

    return {
      nombre: nombreDeFondo,
      saldoInicialImporte: saldoInicial.importe,
      saldoFinalImporte: saldoFinal.importe,
      movimientosCrudos,
    };
  });
}

export async function extraerPosicionesFciSantander(bytes: Uint8Array, periodo: Periodo): Promise<ExtraccionPosicionFciSantander> {
  const bloques = extraerBloquesConPdftotext(bytes);

  const fondos: FondoExtraidoSantander[] = bloques.map((b) => {
    const importesSuscripciones = b.movimientosCrudos.filter((m) => m.tipo === 'suscripcion').map((m) => m.importe);
    const importesRescates = b.movimientosCrudos.filter((m) => m.tipo === 'rescate').map((m) => m.importe);

    let movimientos: MovimientoFciSantander[] = [];
    let movimientosConfiables = true;
    try {
      movimientos = b.movimientosCrudos.map((m) => {
        const fecha = parsearFecha(m.fechaCruda, periodo);
        if (fecha === null) throw new FechaMovimientoInvalidaError();
        return { tipo: m.tipo, cantidad: m.cantidad, precio: m.precio, importe: m.importe, certificado: m.certificado, fecha };
      });
      for (let i = 1; i < movimientos.length; i += 1) {
        if (movimientos[i]!.fecha < movimientos[i - 1]!.fecha) throw new OrdenMovimientoInvalidoError();
      }
    } catch (error) {
      if (!(error instanceof FechaMovimientoInvalidaError) && !(error instanceof OrdenMovimientoInvalidoError)) {
        throw error;
      }
      movimientos = [];
      movimientosConfiables = false;
    }

    const saldoInicialEsCero = esCero(aPuntoFijo(b.saldoInicialImporte));

    return {
      fondo: b.nombre,
      saldoInicialImporte: b.saldoInicialImporte,
      saldoFinalImporte: b.saldoFinalImporte,
      movimientos,
      movimientosConfiables,
      importesSuscripciones,
      importesRescates,
      pepsBloqueado: !saldoInicialEsCero,
      pepsBloqueadoMotivo: saldoInicialEsCero ? null : 'saldo_inicial_no_cero_sin_cantidad_declarada',
    };
  });

  return { fondos };
}
