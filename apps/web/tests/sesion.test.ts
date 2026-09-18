import { describe, expect, it } from 'vitest';
import type { Sesion } from '@sistema-contable/auth';
import { SesionInvalidaError, usuarioIdDeSesion } from '../src/servidor/sesion.ts';

describe('usuarioIdDeSesion', () => {
  it('caso legítimo: con una Sesion real, devuelve usuarioId', () => {
    const sesion: Sesion = { usuarioId: '11111111-1111-1111-1111-111111111111', expiraEn: new Date().toISOString() };
    expect(usuarioIdDeSesion(sesion)).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('🔴 sin sesión (null, mismo contrato que AuthProvider.obtenerSesion cuando getUser() no encuentra ' +
    'usuario o el proveedor no pudo verificar): lanza SesionInvalidaError, nunca deja pasar undefined', () => {
    expect(() => usuarioIdDeSesion(null)).toThrow(SesionInvalidaError);
  });
});
