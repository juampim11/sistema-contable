/**
 * ALTA DE PLACEHOLDER DE DEMO — El Prat (Santander), Módulo 2 capa C.
 *
 * Script de UN SOLO USO, NO un `alta-socio.ts` genérico con el checksum salteado. Existe para un caso
 * puntual: Laura (la contadora) marcó 2-3 filas de El Prat como "es socia" en el export enriquecido,
 * sin dar nombre ni CUIT. No hay base para asumir cuántas personas distintas son — se carga UNA fila
 * placeholder, explícitamente marcada como demo, para que el sistema pueda imputar movimientos a esa
 * fila mientras se espera la confirmación real de Laura.
 *
 * Registrado como excepción — ver `docs/seguridad/registro-excepciones.md`, subsección "Placeholder de
 * demo para El Prat" (no es una fila de la tabla de excepciones: esa tabla es para SACAR un dato real
 * de producción, esto es INSERTAR un sintético marcado, caso distinto).
 *
 *     pnpm alta:socio:placeholder-demo --usuario <uuid> --vigencia-desde YYYY-MM-DD
 *       (el "documento" se pide en un prompt oculto de doble tipeo, igual que `alta-socio.ts` — pero
 *        acá el único valor que el script acepta es el placeholder documentado, nada más)
 *
 * ## Por qué NO es "saltar el checksum" a secas (Ronda 1 — `security-engineer` + `seguridad-datos-financieros`)
 *
 * La primera versión de este diseño saltaba la validación de dígito verificador y aceptaba cualquier
 * CUIT con forma válida (11 dígitos, prefijo AFIP) y verificador inválido. Los dos agentes objetaron:
 * eso reabre la única defensa que existe contra un CUIT REAL mal tipeado (el propio dígito
 * verificador existe para atrapar una transposición). Corregido: el script acepta ÚNICAMENTE el valor
 * EXACTO de `DOCUMENTO_PLACEHOLDER` de abajo — cualquier otra cosa, sea o no un CUIT válido, se
 * rechaza. No es "un `alta-socio` sin validación": es "el único valor que puede entrar es el que ya
 * está en el registro".
 *
 * ## Por qué el cuerpo NO es `99999999`, ni el primer candidato de dígito repetido que se probó
 *
 * La primera propuesta reusaba el cuerpo del CUIT `CANARIO` de `packages/data/src/seed/sintetico.ts`
 * (`'30-99999999-0'`). `seguridad-datos-financieros` (Ronda 1) lo objetó: ese valor está reservado en
 * EXCLUSIVA para los tests anti-fuga INV-5/INV-8 — reusarlo acá no es una fuga, pero rompe la
 * propiedad que el canario necesita (que sea inconfundible con cualquier otro dato, incluido este
 * placeholder). Una segunda propuesta, con un dígito repetido ocho veces, la descartó `code-reviewer`
 * con evidencia del gate: `pnpm barrido` (modo estricto, `privado/` presente) encontró ese cuerpo como
 * coincidencia dentro del material real — una repetición de dígito, con suficiente volumen de números
 * reales en `privado/`, tiene una probabilidad no despreciable de aparecer como substring de un número
 * más largo por pura casualidad. El valor descartado NO se deja escrito acá a propósito, ni siquiera
 * como ejemplo — es exactamente el tipo de candidato que el barrido existe para atrapar, y dejarlo en
 * un comentario reproduciría la misma fuga que este párrafo describe. La lección: **no alcanza con
 * razonar "está fuera de rango" — hay que correr `pnpm barrido` contra el valor elegido y confirmarlo en
 * verde antes de fijarlo.** Eso es lo que se hizo acá.
 *
 * ## El valor, y por qué el cuerpo está fuera de cualquier rango real de asignación
 *
 * `27-98765432-1`. Prefijo `27` (persona física, forma válida de `RE_CUIT`). Cuerpo `98765432`:
 * confirmado contra fuente pública (RENAPER, Disposición 4678/2019) que el DNI argentino es
 * monotónico y en 2026 va de números bajos históricos hasta ~70-71 millones (los recién nacidos desde
 * 2023 arrancan en 70.000.000; el tramo 60.000.000-69.999.999 está reservado pero SÍ se usa para
 * CUIT/CUIL real de extranjeros, así que no sirve como "vacío") — `98.765.432` está muy por encima de
 * cualquier asignación real o previsible durante la vida útil de este piloto, y verificado con
 * `pnpm barrido` en modo estricto contra el material real de `privado/`: sin coincidencia, a diferencia
 * del intento anterior. Verificador: para la base `2798765432` el dígito real da `0` (mismo algoritmo
 * que `packages/shared/src/seguridad/validador-documento.ts`); acá se usa `1`, deliberadamente
 * distinto — ni corrigiendo el dígito a mano el resultado se vuelve una identidad real, porque el
 * cuerpo mismo ya está fuera de rango.
 *
 * ## Qué NO se salta (Ronda 1 — `dba-data`, verificado contra el DDL, no de memoria)
 *
 * Todo lo demás del camino estándar se preserva: `padron_socio_doc_forma_chk` (regex de forma, migración
 * `0013`) lo sigue validando la base igual que a cualquier alta; RLS y el rol `socio`/`contador` sobre
 * `--cliente` los sigue exigiendo `escribirConAuditoria`/`conUsuario`; el hasheo HMAC+pepper lo hace la
 * misma `altaDeSocio` que usa `alta-socio.ts`, sin ninguna rama especial. Lo único que este script NO
 * hace que el estándar sí hace es invocar `verificadorCuitEsValido` — y ni siquiera hace falta:
 * `DOCUMENTO_PLACEHOLDER` está fijado como constante, ya se sabe que su dígito verificador es inválido
 * (test de este mismo archivo lo confirma, mismo patrón que el guard de `packages/data/scripts/sembrar.ts`).
 */

import {
  altaDeSocio,
  cerrarConexiones,
  conUsuario,
  escribirConAuditoria,
  verificarCredencialDeRequest,
} from '@sistema-contable/data';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';
import { pedirValorConfirmado, type EntradaOculta, type SalidaOculta } from './prompt-oculto.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);

/** El único cliente para el que este script existe — El Prat S.A.S., Santander, piloto. NO es un
 *  argumento de la CLI: un script que aceptara cualquier `--cliente` podría, por error de tipeo,
 *  insertar este placeholder en el padrón de OTRO cliente real — fila que después no se puede borrar
 *  (`padron_socio_documento` no tiene `grant delete`/`update` para nadie). Hardcodeado en el bloque de
 *  ejecución directa de abajo (Ronda 1, `dba-data`) — `escribirAltaDePlaceholder` sí lo recibe como
 *  parámetro, para poder testearla contra un tenant sintético sin tocar el piloto real. */
export const CLIENTE_EL_PRAT = '80741296-8cbf-4a4f-bcf1-8e8cb1c57584';

/** Ver el comentario de cabecera — `27-98765432-1`, normalizado a dígitos. Exportado para que el test
 *  de este archivo pueda confirmar, con el algoritmo real, que su dígito verificador es inválido. */
export const DOCUMENTO_PLACEHOLDER = '27987654321';

const DENOMINACION_PLACEHOLDER =
  'Socia 1 (El Prat) - PLACEHOLDER DEMO, sin CUIT real, pendiente confirmar con Laura';

const MOTIVO_AUDITORIA =
  'PLACEHOLDER DEMO - documento sintetico con checksum invalido a proposito, ver ' +
  'docs/seguridad/registro-excepciones.md';

type CamposAltaPlaceholder = 'cliente_id' | 'usuario_id' | 'motivo_codigo' | 'causa_tipo';
const log = loggerAcotado<CamposAltaPlaceholder>();

function causaTipo(error: unknown): string {
  if (!(error instanceof Error)) return 'desconocido';
  const reducido = redactar(error) as { nombre?: string };
  return reducido.nombre ?? 'Error';
}

function imprimir(t: string): void {
  process.stdout.write(t + SALTO);
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

export type ArgumentosAltaPlaceholder = {
  readonly usuario: string;
  readonly vigenciaDesde: string;
};

const MENSAJE_USO =
  `  node apps/cli/src/alta-socio-placeholder-demo.ts --usuario <uuid> --vigencia-desde YYYY-MM-DD${SALTO}${SALTO}` +
  `  El documento NUNCA se pasa por argumento: se pide en un prompt oculto, con doble tipeo. Este ` +
  `script solo acepta el valor placeholder documentado en docs/seguridad/registro-excepciones.md.`;

export function argumentos(argv: readonly string[]): ArgumentosAltaPlaceholder {
  for (const prohibida of ['documento', 'cuit', 'cuil', 'dni'] as const) {
    if (argv.some((a) => a === `--${prohibida}` || a.startsWith(`--${prohibida}=`))) {
      throw new Error(
        `--${prohibida} ya no es un argumento válido: quedaría en texto plano en el historial de ` +
          `PowerShell. El documento se pide en un prompt oculto, nunca por argumento.${SALTO}${SALTO}${MENSAJE_USO}`,
      );
    }
  }
  if (argv.some((a) => a === '--cliente' || a.startsWith('--cliente='))) {
    throw new Error(
      `--cliente no es un argumento de este script: el único cliente válido es El Prat, hardcodeado ` +
        `a propósito (ver el comentario de cabecera). Si necesitás dar de alta un socio de otro ` +
        `cliente, usá alta-socio.ts.${SALTO}${SALTO}${MENSAJE_USO}`,
    );
  }

  const mapa = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const actual = argv[i];
    if (actual?.startsWith('--')) {
      const clave = actual.slice(2);
      const valor = argv[i + 1];
      if (valor === undefined || valor.startsWith('--')) {
        throw new Error(`El argumento --${clave} necesita un valor.${SALTO}${SALTO}${MENSAJE_USO}`);
      }
      mapa.set(clave, valor);
      i += 1;
    }
  }

  const usuario = mapa.get('usuario') ?? '';
  const vigenciaDesde = mapa.get('vigencia-desde') ?? '';
  if (!RE_UUID.test(usuario)) {
    throw new Error(`--usuario tiene que ser un uuid válido.${SALTO}${SALTO}${MENSAJE_USO}`);
  }
  if (!RE_FECHA.test(vigenciaDesde)) {
    throw new Error(`--vigencia-desde tiene que tener forma YYYY-MM-DD.${SALTO}${SALTO}${MENSAJE_USO}`);
  }
  return { usuario, vigenciaDesde };
}

export type MotivoAbortoAltaPlaceholder = 'credencial_saltea_rls' | 'contexto_no_aislado';
export type ResultadoAltaPlaceholder =
  | { readonly estado: 'alta'; readonly socioId: string; readonly documentoUltimos4: string; readonly pepperId: string }
  | { readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoAltaPlaceholder };

/**
 * El documento YA viene resuelto (test o prompt) — mismo criterio de separación que `alta-socio.ts`.
 * `clienteId` es parámetro de la función (para poder testearla contra un tenant sintético) pero NO de
 * la CLI: el bloque de ejecución directa, más abajo, siempre pasa `CLIENTE_EL_PRAT`.
 */
export async function escribirAltaDePlaceholder(args: {
  readonly clienteId: string;
  readonly usuario: string;
  readonly vigenciaDesde: string;
  readonly documento: string;
}): Promise<ResultadoAltaPlaceholder> {
  if (args.documento !== DOCUMENTO_PLACEHOLDER) {
    throw new Error(
      'Este script solo acepta el valor placeholder documentado en docs/seguridad/registro-excepciones.md. ' +
        'Si tipeaste un CUIT real por error, no lo reintentes acá: usá alta-socio.ts.',
    );
  }

  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('alta_socio_placeholder.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  const resultado = await conUsuario(args.usuario, (tx) =>
    escribirConAuditoria(
      tx,
      {
        clienteId: args.clienteId,
        accion: 'escritura',
        recurso: 'padron_socio',
        motivo: MOTIVO_AUDITORIA,
      },
      (ctx) =>
        altaDeSocio(tx, ctx, {
          clienteId: args.clienteId,
          denominacion: DENOMINACION_PLACEHOLDER,
          documentoTipo: 'cuit',
          documento: args.documento,
          vigenteDesde: args.vigenciaDesde,
        }),
    ),
  );

  log.info('alta_socio_placeholder.creado', {
    cliente_id: args.clienteId,
    usuario_id: args.usuario,
  });

  return {
    estado: 'alta',
    socioId: resultado.socioId,
    documentoUltimos4: resultado.documentoUltimos4,
    pepperId: resultado.pepperId,
  };
}

/** Prompt del documento — solo forma (11 dígitos), sin checksum: el checksum lo exige
 *  `escribirAltaDePlaceholder` por igualdad exacta contra `DOCUMENTO_PLACEHOLDER`, no acá. */
export async function pedirDocumentoPlaceholderConfirmado(
  entrada: EntradaOculta = process.stdin,
  salida: SalidaOculta = process.stdout,
): Promise<string> {
  const valor = await pedirValorConfirmado(
    {
      primero: '  Documento placeholder (11 dígitos, el que figura en el registro E-3): ',
      segundo: '  Repetí el documento para confirmar: ',
      aviso: [
        'Este script SOLO acepta el valor placeholder exacto documentado en',
        'docs/seguridad/registro-excepciones.md (subsección del placeholder de El Prat).',
        'No es un alta de socio real — no tipees un CUIT real acá.',
      ],
    },
    entrada,
    salida,
  );
  return valor.replace(/\D/g, '');
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/alta-socio-placeholder-demo.ts');

if (esEjecucionDirecta) {
  try {
    const args = argumentos(process.argv.slice(2));

    imprimir('');
    imprimir(`  Cliente          El Prat S.A.S. (${CLIENTE_EL_PRAT}, hardcodeado)`);
    imprimir(`  Denominación     ${DENOMINACION_PLACEHOLDER}`);
    imprimir(`  Tipo documento   cuit (placeholder)`);
    imprimir(`  Vigente desde    ${args.vigenciaDesde}`);

    const documento = await pedirDocumentoPlaceholderConfirmado();
    const r = await escribirAltaDePlaceholder({ ...args, clienteId: CLIENTE_EL_PRAT, documento });

    imprimir('');
    if (r.estado === 'alta') {
      imprimir('  Alta OK (placeholder de demo).');
      imprimir(`    socio_id     ${r.socioId}`);
      imprimir(`    documento    ••••${r.documentoUltimos4}`);
      imprimir(`    pepper_id    ${r.pepperId}`);
    } else {
      imprimir(`  ABORTA: ${JSON.stringify(r)}`);
    }
    imprimir('');
    process.exit(r.estado === 'abortado' ? 1 : 0);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${SALTO}`);
    process.exit(2);
  } finally {
    await cerrarConexiones();
  }
}
