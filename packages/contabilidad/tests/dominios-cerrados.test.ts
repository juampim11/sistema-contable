/**
 * LA DIRECCIÓN CÓDIGO → BASE de los dominios cerrados del motor.
 *
 * Reemplaza a `dominios-pendientes.test.ts`, que existía mientras `0014` no existía y nominaba los
 * dominios "sin check todavía". Ya no queda ninguno: `0014_reconocimiento_persistido.sql` creó los
 * ocho checks.
 *
 * 🔴 Pero el hueco que ese archivo cubría NO se cerró solo, y por eso este existe. El test de
 * cobertura inversa de `packages/data/tests/catalogo.test.ts` va en la dirección BASE → CÓDIGO
 * (recorre `pg_constraint` y exige que cada check con forma de dominio cerrado esté en
 * `DOMINIOS_CERRADOS`). No hay ningún control en la dirección contraria: una constante NUEVA en
 * `nucleo/tipos.ts`, sin check y sin fila, no pone rojo absolutamente nada — el gate se quedaría
 * verde con un dominio del motor sin garantía estructural, que es exactamente lo que `0014` vino a
 * cerrar.
 *
 * Este archivo es la otra mitad: toda constante de dominio cerrado del núcleo tiene que estar
 * NOMINADA en `DOMINIOS_CERRADOS`. Es un barrido de texto sobre el archivo de tests del otro paquete
 * —`packages/contabilidad` no puede importar `packages/data` ni al revés (R-A/R-B)— y es el mismo
 * mecanismo que R-H/R-H bis usan para los espejos: sobre una lista plana de nombres, el substring
 * alcanza.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONCEPTOS_CANONICOS } from '../src/nucleo/catalogo.ts';
import {
  CLASES_RECONOCIMIENTO,
  ESTADOS_RESOLUCION,
  LADOS,
  MOTIVOS_SIN_RECONOCER,
  POLARIDADES,
  QUE_DECIDE,
  REGIMENES_CON_MATCHES,
  TIPOS_MOVIMIENTO,
  VIAS_EVIDENCIA,
} from '../src/nucleo/tipos.ts';

const RAIZ_REPO = join(import.meta.dirname, '..', '..', '..');
const CATALOGO_TEST = join(RAIZ_REPO, 'packages', 'data', 'tests', 'catalogo.test.ts');

/**
 * Los DIEZ dominios cerrados del motor, con el check que los espeja en la base. La lista es
 * NOMINADA: una constante nueva que no se agregue acá no rompe nada por sí sola — por eso el último
 * test cuenta las constantes exportadas y exige que no haya más de las declaradas.
 *
 * Los dos últimos entraron con `0021`, y el segundo tiene una asimetría que hay que leer con
 * cuidado: `REGIMENES_CON_MATCHES` espeja el check de la SATÉLITE, que admite dos valores, mientras
 * que la columna GENERADA del padre produce TRES (`socio_unico`, `varios`, `sin_matches`). No es un
 * descuido: se espeja lo que el check afirma. El tercer valor no necesita constante porque ninguna
 * escritura lo elige — lo calcula la generada, y la satélite que intentara usarlo no encuentra padre.
 */
const DOMINIOS_DEL_MOTOR = [
  { constante: 'CLASES_RECONOCIMIENTO', valores: CLASES_RECONOCIMIENTO, check: 'reconocimiento_clase_chk' },
  { constante: 'TIPOS_MOVIMIENTO', valores: TIPOS_MOVIMIENTO, check: 'reconocimiento_tipo_chk' },
  { constante: 'CONCEPTOS_CANONICOS', valores: CONCEPTOS_CANONICOS, check: 'reconocimiento_concepto_chk' },
  { constante: 'POLARIDADES', valores: POLARIDADES, check: 'reconocimiento_polaridad_chk' },
  { constante: 'LADOS', valores: LADOS, check: 'reconocimiento_lado_chk' },
  { constante: 'VIAS_EVIDENCIA', valores: VIAS_EVIDENCIA, check: 'reconocimiento_via_chk' },
  { constante: 'QUE_DECIDE', valores: QUE_DECIDE, check: 'reconocimiento_decide_chk' },
  { constante: 'MOTIVOS_SIN_RECONOCER', valores: MOTIVOS_SIN_RECONOCER, check: 'reconocimiento_motivo_chk' },
  { constante: 'ESTADOS_RESOLUCION', valores: ESTADOS_RESOLUCION, check: 'contrapartida_estado_chk' },
  { constante: 'REGIMENES_CON_MATCHES', valores: REGIMENES_CON_MATCHES, check: 'contrapartida_match_regimen_chk' },
] as const;

describe('dominios cerrados del motor: código → base', () => {
  it.each(DOMINIOS_DEL_MOTOR)(
    '$constante: valores no vacíos, con la forma que un check de Postgres puede espejar',
    ({ valores }) => {
      expect(valores.length, 'un dominio cerrado vacío es una lista muerta').toBeGreaterThan(1);
      for (const v of valores) {
        expect(v, `«${v}» no tiene la forma /^[a-z0-9_]+$/ que un check … = ANY (ARRAY[…]) espeja`).toMatch(
          /^[a-z0-9_]+$/,
        );
      }
    },
  );

  it.each(DOMINIOS_DEL_MOTOR)(
    '$constante está nominada en DOMINIOS_CERRADOS, con su check de 0014',
    ({ constante, check }) => {
      const contenido = readFileSync(CATALOGO_TEST, 'utf8');
      expect(
        contenido.includes(constante),
        `${constante} no aparece en packages/data/tests/catalogo.test.ts — el dominio existe en el ` +
          'código y nada lo ata al check de la base.',
      ).toBe(true);
      expect(
        contenido.includes(check),
        `el check ${check} no aparece en DOMINIOS_CERRADOS. La cobertura inversa (base → código) lo ` +
          'va a agarrar igual, pero recién cuando alguien corra los tests contra una base migrada.',
      ).toBe(true);
    },
  );

  it('ningún nombre de check está duplicado entre filas', () => {
    const checks = DOMINIOS_DEL_MOTOR.map((d) => d.check);
    expect(new Set(checks).size).toBe(checks.length);
  });

  /**
   * 🔴 Anti-lista-muerta, en la dirección que importa. `DOMINIOS_DEL_MOTOR` es una lista escrita a
   * mano: si mañana alguien agrega `FORMAS_DE_PAGO` a `tipos.ts` y no la nomina acá, ningún test de
   * arriba se entera. Esto cuenta las constantes de dominio cerrado que el archivo EXPORTA y exige
   * que coincidan con las declaradas — un `export const X = [...] as const` nuevo pone esto rojo.
   */
  it('no hay constantes de dominio cerrado en tipos.ts fuera de las nominadas', () => {
    const tipos = readFileSync(join(import.meta.dirname, '..', 'src', 'nucleo', 'tipos.ts'), 'utf8');
    const exportadas = [...tipos.matchAll(/export const ([A-Z_]+) = \[/g)].map((m) => m[1]);
    const nominadas = new Set(DOMINIOS_DEL_MOTOR.map((d) => d.constante));

    const huerfanas = exportadas.filter((n) => n !== undefined && !nominadas.has(n as never));
    expect(
      huerfanas,
      'hay dominios cerrados en nucleo/tipos.ts que no están nominados acá ni, por lo tanto, atados a ' +
        'ningún check de la base. Agregar la fila (y su check, en una migración nueva).',
    ).toEqual([]);
    expect(exportadas.length, 'no se está barriendo tipos.ts').toBeGreaterThan(4);
  });
});
