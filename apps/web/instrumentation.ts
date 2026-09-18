/**
 * Hook de arranque de Next.js (App Router, estable desde Next 15 sin flag experimental) — corre UNA
 * vez por instancia del proceso, antes del primer request. Único lugar del scaffold donde el guard de
 * arranque (`verificarGuardDeArranque`) se ejecuta de verdad contra el entorno real, no solo en test.
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    const { verificarGuardDeArranque } = await import('./src/servidor/guard-arranque.ts');
    verificarGuardDeArranque();
  }
}
