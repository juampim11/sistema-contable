import { describe, expect, it } from 'vitest';
import { AdapterSupabaseNoImplementadoError, crearAdapterSupabase } from '../src/adapters/supabase.ts';

const UUID_SINTETICO = '11111111-2222-4333-8444-555555555555';

describe('adapter Supabase — stub deliberado (ADR-0006 §1, se implementa en PR3)', () => {
  it('iniciarSesion lanza AdapterSupabaseNoImplementadoError', async () => {
    const adapter = crearAdapterSupabase();
    await expect(adapter.iniciarSesion({ email: 'x', password: 'y' })).rejects.toThrow(
      AdapterSupabaseNoImplementadoError,
    );
  });

  it('cerrarSesion lanza AdapterSupabaseNoImplementadoError', async () => {
    const adapter = crearAdapterSupabase();
    await expect(
      adapter.cerrarSesion({ usuarioId: UUID_SINTETICO, expiraEn: new Date().toISOString() }),
    ).rejects.toThrow(AdapterSupabaseNoImplementadoError);
  });

  it('obtenerSesion lanza AdapterSupabaseNoImplementadoError', async () => {
    const adapter = crearAdapterSupabase();
    await expect(adapter.obtenerSesion(new Request('http://localhost/cualquier-ruta'))).rejects.toThrow(
      AdapterSupabaseNoImplementadoError,
    );
  });

  it('el mensaje es exactamente el que pide el ADR: "implementar en PR 3 de ADR-0006"', async () => {
    const adapter = crearAdapterSupabase();
    await expect(adapter.iniciarSesion({ email: 'x', password: 'y' })).rejects.toThrow(
      'adapter Supabase: implementar en PR 3 de ADR-0006',
    );
  });
});
