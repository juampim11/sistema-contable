/**
 * `leerClientesAccesibles` — primera consumidora real: Pantalla 1 del wizard (PR4, "elegir cliente").
 *
 * Foco del test: el predicado explícito `and id in (select app.accessible_tenant_ids())` (hallazgo de
 * `seguridad-datos-financieros`, convocatoria PR4) — sin él, un llamador futuro bajo `conJob(...)`
 * (BYPASSRLS) devolvería TODOS los clientes de TODOS los estudios. Con `conUsuario`, la RLS ya filtra
 * igual; el caso real que prueba el predicado es justamente el de `conJob`.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conJob, conUsuario } from '../src/db/conexion.ts';
import { leerClientesAccesibles } from '../src/tenancy/lecturas.ts';
import { sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

describe('leerClientesAccesibles', () => {
  it('el socio del estudio ve SUS clientes (A y B), nunca el del otro estudio (C)', async () => {
    const clientes = await conUsuario(USUARIOS.socio, (tx) => leerClientesAccesibles(tx));
    const ids = clientes.map((c) => c.id);

    expect(ids).toContain(s.clienteA);
    expect(ids).toContain(s.clienteB);
    expect(ids).not.toContain(s.clienteC);
  });

  it('el socio del OTRO estudio ve solo su cliente (C), nunca A ni B', async () => {
    const clientes = await conUsuario(USUARIOS.socioOtroEstudio, (tx) => leerClientesAccesibles(tx));
    const ids = clientes.map((c) => c.id);

    expect(ids).toContain(s.clienteC);
    expect(ids).not.toContain(s.clienteA);
    expect(ids).not.toContain(s.clienteB);
  });

  it('🔴 EN VIVO: bajo conJob (BYPASSRLS, sin usuario seteado), el predicado explícito falla ' +
    'cerrado — cero clientes, NUNCA la base entera', async () => {
    const clientes = await conJob('mantenimiento', (tx) => leerClientesAccesibles(tx));
    expect(clientes).toEqual([]);
  });
});
