'use server';

/**
 * Logout del header global — mismo criterio de exención de R-W que el login (ver
 * `reglas-de-codigo.test.ts`): cerrar una sesión es una operación de IDENTIDAD, no de datos de
 * dominio, y no pasa por `conSesion()`.
 */
import { redirect } from 'next/navigation';
import { crearAuthProvider } from '@sistema-contable/auth';
import { cookiesDeNextHeaders } from '../../servidor/sesion.ts';

const PEDIDO_SINTETICO = new Request('http://localhost/');

export async function cerrarSesionAction(): Promise<void> {
  const cookiesAdapter = await cookiesDeNextHeaders();
  const authProvider = crearAuthProvider(cookiesAdapter);
  const sesion = await authProvider.obtenerSesion(PEDIDO_SINTETICO);
  if (sesion) await authProvider.cerrarSesion(sesion);
  redirect('/login');
}
