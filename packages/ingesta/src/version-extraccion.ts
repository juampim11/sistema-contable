/**
 * `VERSION_DEL_EXTRACTOR` — el contador manual del pipeline de extracción de contraparte, mismo
 * patrón que `VERSION_DEL_MOTOR` (`packages/contabilidad/src/nucleo/version.ts`).
 *
 * ## Por qué esto existe
 *
 * `packages/contabilidad` tiene su trinquete de versión desde `0014`, pero `packages/ingesta` no
 * tenía ninguno para su propio pipeline de EXTRACCIÓN — la parte que corre ANTES del motor:
 * `depurarGlosa()` (`glosa.ts`) separa los identificadores de la glosa bancaria, y
 * `extraerCandidatosDeContraparte()` (`contraparte.ts`) los convierte en candidatos de contraparte
 * hasheados, usando los detectores de forma compartidos (`RE_CUIT`/`RE_DNI`/`RE_CBU`/
 * `RE_CORRIDA_LARGA`, `packages/shared/src/seguridad/detectores-forma.ts`).
 *
 * El 2026-09-01 se confirmó el costo real de no tenerlo: `RE_CUIT` tenía un bug de `\b` (no separa
 * una letra de un dígito contiguo) corregido el 2026-08-23 (`cb084a0`), y el lote de ROKA —ingerido
 * 11 días antes del fix— quedó con 569 de 1346 movimientos sin ningún candidato de contraparte,
 * porque nadie tenía forma de saber, sin investigar a mano, qué lotes se ingirieron con qué versión
 * del extractor. `reclasificar-contraparte.ts` (el reproceso que corrige esto) necesita un número
 * que distinga "este lote se ingirió con el bug" de "este lote ya está al día", y ese número es
 * este.
 *
 * ## Por qué un archivo PROPIO, y no una constante suelta en `glosa.ts`
 *
 * Mismo argumento que `version.ts` en `contabilidad`: el archivo que MIDE la huella del pipeline no
 * puede incluirse a sí mismo en esa huella (se auto-invalidaría cada vez que alguien lo lea). Acá el
 * argumento es más fuerte todavía: el pipeline de extracción son TRES archivos que viven en DOS
 * paquetes distintos (`packages/ingesta/src/glosa.ts`, `packages/ingesta/src/contraparte.ts` y
 * `packages/shared/src/seguridad/detectores-forma.ts`) — no hay un único `directorio` que barrer
 * como en `nucleo/`, así que la exclusión de este archivo no puede resolverse con un `NO_ENTRAN` por
 * nombre: hace falta que la constante viva afuera de la lista de archivos que se hashean, y eso
 * significa un archivo separado.
 *
 * ## El olvido falla ABIERTO y EN SILENCIO — mismo motivo que el motor
 *
 * Sin gate, un cambio futuro en `RE_CUIT`/`RE_DNI`/`RE_CBU`/`depurarGlosa`/
 * `extraerCandidatosDeContraparte` no tendría forma de decirle a
 * `detectar-lotes-desactualizados.ts` que los lotes viejos volvieron a quedar atrás — la próxima vez
 * que alguien corrija un detector, la investigación manual de hoy se repite entera. El gate vive en
 * `packages/ingesta/tests/version-del-extractor.test.ts`, que compara la huella real contra el
 * artefacto commiteado (`packages/ingesta/version-del-extractor.json`). La aceptación es un
 * TRINQUETE, igual que el motor: `pnpm extractor:version:aceptar` exige bump, o
 * `--sin-bump --motivo "…"` para un cambio que demostrablemente no altera ningún resultado. Ver
 * `packages/ingesta/scripts/version-del-extractor.ts`.
 */
export const VERSION_DEL_EXTRACTOR = 1;
