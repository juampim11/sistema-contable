import { describe, expect, it } from 'vitest';
import { VariableDeServidorFiltradaError, verificarGuardDeArranque } from '../src/servidor/guard-arranque.ts';

describe('verificarGuardDeArranque', () => {
  it('caso legítimo: sin ninguna variable prohibida, no lanza', () => {
    expect(() => verificarGuardDeArranque({ DATABASE_URL_APP: 'postgres://app_request_dev@x/y' })).not.toThrow();
  });

  it('🔴 SUPABASE_SERVICE_ROLE_KEY presente: lanza VariableDeServidorFiltradaError', () => {
    expect(() => verificarGuardDeArranque({ SUPABASE_SERVICE_ROLE_KEY: 'x' })).toThrow(VariableDeServidorFiltradaError);
  });

  it('🔴 DATABASE_URL_JOB presente: lanza', () => {
    expect(() => verificarGuardDeArranque({ DATABASE_URL_JOB: 'postgres://app_job@x/y' })).toThrow(
      VariableDeServidorFiltradaError,
    );
  });

  it('🔴 DATABASE_URL (dueño del esquema) presente: lanza', () => {
    expect(() => verificarGuardDeArranque({ DATABASE_URL: 'postgres://sistema_contable@x/y' })).toThrow(
      VariableDeServidorFiltradaError,
    );
  });

  it('una variable vacía ("") no cuenta como presente', () => {
    expect(() => verificarGuardDeArranque({ DATABASE_URL_JOB: '' })).not.toThrow();
  });
});
