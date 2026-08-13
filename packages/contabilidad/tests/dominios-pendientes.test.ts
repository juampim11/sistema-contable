/**
 * Los dominios cerrados de `packages/contabilidad` que TODAVÍA no tienen `check` en la base — no existe
 * la migración `0014`. El test de cobertura inversa de `packages/data/tests/catalogo.test.ts` va en la
 * dirección BASE → código (recorre los checks reales y exige que cada uno esté en `DOMINIOS_CERRADOS`);
 * no hay chequeo código → base. Declarar estas constantes hoy, sin migración, no pone rojo nada allá —
 * pero sin este archivo, la conexión con `0014` se puede olvidar en silencio.
 *
 * La lista es NOMINADA: agregar una constante nueva y olvidarla acá cuesta el gate (test 3).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOTIVOS_SIN_RECONOCER, QUE_DECIDE, TIPOS_MOVIMIENTO, VIAS_EVIDENCIA } from '../src/nucleo/tipos.ts';

const RAIZ = join(import.meta.dirname, '..');

/**
 * ⏳ Cuando la migración `0014` cree el check correspondiente, mover la fila a `DOMINIOS_CERRADOS`
 * (`packages/data/tests/catalogo.test.ts`), reemplazar el docblock de la constante por la fórmula del
 * repo ("Idéntica a `x_chk`; hay test de catálogo"), y borrarla de acá.
 *
 * `CONCEPTOS_CANONICOS` (`src/nucleo/catalogo.ts`, check `reconocimiento_concepto_chk`) se agrega en el
 * paso P4 del plan, cuando el archivo exista.
 */
const DOMINIOS_SIN_CHECK_TODAVIA = [
  { constante: 'TIPOS_MOVIMIENTO', valores: TIPOS_MOVIMIENTO, archivo: 'src/nucleo/tipos.ts',
    check: 'reconocimiento_tipo_chk', migracion: '0014' },
  { constante: 'VIAS_EVIDENCIA', valores: VIAS_EVIDENCIA, archivo: 'src/nucleo/tipos.ts',
    check: 'reconocimiento_via_chk', migracion: '0014' },
  { constante: 'QUE_DECIDE', valores: QUE_DECIDE, archivo: 'src/nucleo/tipos.ts',
    check: 'reconocimiento_decide_chk', migracion: '0014' },
  { constante: 'MOTIVOS_SIN_RECONOCER', valores: MOTIVOS_SIN_RECONOCER, archivo: 'src/nucleo/tipos.ts',
    check: 'reconocimiento_motivo_chk', migracion: '0014' },
] as const;

describe('dominios cerrados sin migración todavía', () => {
  it.each(DOMINIOS_SIN_CHECK_TODAVIA)(
    '$constante: valores no vacíos, con la forma que un check de Postgres puede espejar',
    ({ valores }) => {
      expect(valores.length, 'un dominio cerrado vacío es una lista muerta').toBeGreaterThan(0);
      for (const v of valores) {
        expect(v, `«${v}» no tiene la forma /^[a-z0-9_]+$/ que un check … = ANY (ARRAY[…]) espeja`).toMatch(
          /^[a-z0-9_]+$/,
        );
      }
    },
  );

  it.each(DOMINIOS_SIN_CHECK_TODAVIA)(
    '$constante: el archivo declarado todavía dice explícitamente que no tiene check',
    ({ archivo, constante }) => {
      const contenido = readFileSync(join(RAIZ, archivo), 'utf8');
      // Sin esta nota, el día que alguien la borre sin agregar la fila en DOMINIOS_CERRADOS de
      // catalogo.test.ts, la desconexión entre 0014 y el código queda muda — no hay ningún otro
      // control que lo note.
      const indice = contenido.indexOf(constante);
      expect(indice, `no encontré la constante ${constante} en ${archivo}`).toBeGreaterThanOrEqual(0);
      const ventana = contenido.slice(Math.max(0, indice - 800), indice);
      expect(
        ventana,
        `${archivo} declara ${constante} sin la nota "TODAVÍA NO TIENE CHECK EN LA BASE" cerca — si ya ` +
          'tiene check en la base, esta fila tiene que moverse a DOMINIOS_CERRADOS y borrarse de acá.',
      ).toContain('TODAVÍA NO TIENE CHECK EN LA BASE');
    },
  );

  it('ningún nombre de check está duplicado entre filas', () => {
    const checks = DOMINIOS_SIN_CHECK_TODAVIA.map((d) => d.check);
    expect(new Set(checks).size).toBe(checks.length);
  });
});
