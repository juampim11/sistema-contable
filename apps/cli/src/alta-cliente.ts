/**
 * ALTA DE UN CLIENTE, colgado de un `estudio` existente.
 *
 *     node apps/cli/src/alta-cliente.ts \
 *       --estudio <uuid> --nombre "<etiqueta>" --usuario <uuid>
 *
 * ## Por qué `--usuario`, y no `conJob`
 *
 * La policy `tenant_node_wr` (migración `0001_tenancy.sql`) exige `has_role_on(parent_id, [socio,
 * admin_plataforma])` evaluado contra `app.current_user_id()`: sin un socio actuante bajo `conUsuario`,
 * el insert no tiene cómo pasar RLS. `conJob` saltearía el único control de autorización que existe
 * para esta operación — hallazgo convergente de `arquitecto-software`, `security-engineer` y `dba-data`
 * (HANDOFF 2026-08-11, entrada 27, punto 1). Mismo patrón que `alta-cuenta.ts`.
 *
 * ## Qué NUNCA recibe ni imprime
 *
 * Nunca un CUIT: `--nombre` se rechaza si tiene forma de CUIT (mismo detector que el redactor de logs,
 * `RE_CUIT` de `@sistema-contable/shared/seguridad`). Lo único que se imprime es el uuid nuevo.
 */

import { z } from 'zod';
import { RE_CUIT, sinEstado } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';
import {
  altaDeClienteEnEstudio,
  cerrarConexiones,
  conUsuario,
  verificarCredencialDeRequest,
} from '@sistema-contable/data';

cargarEnv();

const SALTO = String.fromCharCode(10);
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `sinEstado(RE_CUIT)` porque `RE_CUIT` es un `RegExp` con flag `g` COMPARTIDO entre varios módulos
// (`redactar.ts`, `glosa.ts`, dos adaptadores) — reusar la instancia con `.test()` arrastraría
// `lastIndex` entre corridas y podría saltear el match en silencio. Ver el comentario de `sinEstado`
// en `detectores-forma.ts`.
const RE_CUIT_SIN_ESTADO = sinEstado(RE_CUIT);

const esquema = z.object({
  estudio: z.string().regex(RE_UUID),
  usuario: z.string().regex(RE_UUID),
  /** Etiqueta humana provisoria. **Nunca** un CUIT ni la razón social real. */
  nombre: z
    .string()
    .min(1)
    .max(60)
    .refine((v) => !RE_CUIT_SIN_ESTADO.test(v), 'no puede tener forma de CUIT'),
});

function argumentos(): z.infer<typeof esquema> {
  const mapa = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a?.startsWith('--')) {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) {
        mapa.set(a.slice(2), v);
        i += 1;
      }
    }
  }

  const r = esquema.safeParse(Object.fromEntries(mapa));
  if (!r.success) {
    throw new Error(
      `Argumentos inválidos: ${r.error.issues.map((i) => `--${String(i.path[0])}`).join(', ')}.${SALTO}${SALTO}` +
        `  node apps/cli/src/alta-cliente.ts --estudio <uuid> --nombre "<etiqueta>" --usuario <uuid>${SALTO}${SALTO}` +
        `El nombre no puede tener forma de CUIT ni superar 60 caracteres.`,
    );
  }
  return r.data;
}

function imprimir(t: string): void {
  process.stdout.write(t + SALTO);
}

// -----------------------------------------------------------------------------

const args = argumentos();

// El guard, ANTES de tocar la base: si va a abortar, que aborte sin haber abierto ninguna transacción.
const credencial = await verificarCredencialDeRequest();
if (credencial.salteaRls || credencial.esSuperusuario) {
  imprimir('');
  imprimir('  ABORTA: la credencial de DATABASE_URL_APP saltea RLS o es superusuario.');
  imprimir('  El alta de un cliente con las políticas fuera de juego escribe sin verificar el tenant.');
  imprimir('');
  process.exit(1);
}

try {
  const resultado = await conUsuario(args.usuario, (tx) =>
    altaDeClienteEnEstudio(tx, { estudioId: args.estudio, nombre: args.nombre }),
  );

  imprimir(resultado.clienteId);
} finally {
  await cerrarConexiones();
}
