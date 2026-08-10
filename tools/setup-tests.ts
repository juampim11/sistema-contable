/**
 * Setup de los tests: carga el `.env` de la raíz y fija el entorno.
 *
 * `APP_ENTORNO=local` se fuerza acá: un test no corre nunca contra staging ni producción, y si alguien
 * tiene un `.env` apuntando a otro lado, el guard de arranque y los helpers lo van a rechazar igual.
 */

import { cargarEnv } from './cargar-env.ts';

cargarEnv();

process.env['APP_ENTORNO'] = 'local';
process.env['LOG_LEVEL'] = process.env['LOG_LEVEL'] ?? 'error';
