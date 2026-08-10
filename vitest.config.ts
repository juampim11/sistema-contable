import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `tools/` también se testea: el barrido de fuga es un control de seguridad y necesita su propia
    // verificación (un control que nunca se probó rojo no existe).
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts', 'tools/**/*.test.ts'],
    // Los tests de base comparten un Postgres real y siembran las mismas tablas: si corren en
    // paralelo se pisan. Un solo proceso, en serie.
    fileParallelism: false,
    setupFiles: ['tools/setup-tests.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
