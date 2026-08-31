/**
 * `packages/motor-conciliacion` no puede importar `packages/data` (regla espejo,
 * `reglas-de-codigo.test.ts`), así que duplica `RolFuncionalCuenta`/`CuentaResolucion` como
 * `RolFuncionalCuentaMotor`/`CuentaResolucionMotor` (mismo patrón que `TIPOS_CUENTA`/
 * `TIPOS_CUENTA_ALTA` en `catalogo.test.ts`). Este archivo es el árbitro: un test SÍ puede cruzar
 * el límite que los `src/` no pueden ("un test puede armar el escenario completo").
 *
 * Sin este test, agregar un valor a `ROLES_FUNCIONALES_CUENTA`/`CUENTA_RESOLUCIONES` (packages/data)
 * sin actualizar su espejo en `motor-conciliacion` compila igual en los dos lados — el resolver
 * simplemente nunca reconocería el valor nuevo, en silencio.
 */

import { describe, expect, it } from 'vitest';
import { CUENTA_RESOLUCIONES, ROLES_FUNCIONALES_CUENTA } from '../src/cierre/tipos.ts';
import {
  CUENTA_RESOLUCIONES_MOTOR,
  ROLES_FUNCIONALES_CUENTA_MOTOR,
} from '../../motor-conciliacion/src/resolver.ts';

describe('vocabulario duplicado entre packages/data y packages/motor-conciliacion, sin divergir', () => {
  it('ROLES_FUNCIONALES_CUENTA === ROLES_FUNCIONALES_CUENTA_MOTOR (mismo conjunto)', () => {
    expect([...ROLES_FUNCIONALES_CUENTA_MOTOR].sort()).toEqual([...ROLES_FUNCIONALES_CUENTA].sort());
  });

  it('CUENTA_RESOLUCIONES === CUENTA_RESOLUCIONES_MOTOR (mismo conjunto)', () => {
    expect([...CUENTA_RESOLUCIONES_MOTOR].sort()).toEqual([...CUENTA_RESOLUCIONES].sort());
  });

  it('ninguna de las dos listas está vacía (un conjunto vacío pasaría "igual" por vacío en los dos lados)', () => {
    expect(ROLES_FUNCIONALES_CUENTA.length).toBeGreaterThan(0);
    expect(CUENTA_RESOLUCIONES.length).toBeGreaterThan(0);
  });
});
