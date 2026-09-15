import { describe, expect, it } from 'vitest';
import type { Sesion } from '../src/auth-provider.ts';

const UUID_SINTETICO = '11111111-2222-4333-8444-555555555555';

describe('Sesion — identidad opaca, sin rol ni capacidad (ADR-0006 §1)', () => {
  it('un objeto Sesion de ejemplo solo tiene usuarioId y expiraEn', () => {
    const sesion: Sesion = {
      usuarioId: UUID_SINTETICO,
      expiraEn: new Date().toISOString(),
    };

    expect(Object.keys(sesion).sort()).toEqual(['expiraEn', 'usuarioId']);
  });

  it('el tipo Sesion rechaza en compilación un campo de rol (ver @ts-expect-error)', () => {
    // `rol` no es un campo válido de `Sesion`: el rol se resuelve SIEMPRE en Postgres (RLS,
    // `app.has_capacidad_en`), nunca en la sesión (ADR-0006 §1). Si el `@ts-expect-error` de abajo
    // deja de dispararse, `Sesion` dejó de ser opaca y el typecheck del repo lo tiene que rechazar.
    const conRolFiltrado: Sesion = {
      usuarioId: UUID_SINTETICO,
      expiraEn: new Date().toISOString(),
      // @ts-expect-error — propiedad excedente ('rol') no declarada en Sesion.
      rol: 'socio',
    };

    expect(conRolFiltrado).toBeDefined();
  });
});
