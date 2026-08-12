/**
 * REGISTRO DE CLASIFICACIÓN DE CAMPOS — ADR-0002 §A.3.
 *
 * **Fuente única de verdad.** De acá derivan, sin listas paralelas:
 *   - el redactor de logs (`redactar.ts`),
 *   - el tipo de campos loggeables (`../observabilidad/logger.ts`),
 *   - los tests de catálogo que exigen RLS, chequeo de rol en lectura y unicidad por tenant.
 *
 * REGLAS DE MANTENIMIENTO (verificadas por `tests/clasificacion.test.ts`):
 *   1. Toda tabla del esquema tiene que estar acá. Tabla nueva sin clasificar → CI rojo.
 *   2. Toda columna de una tabla clasificada tiene que estar acá. Columna nueva sin clasificar → rojo.
 *   3. El default de una columna nueva en una tabla con `cliente_id` es **N2**. No hay "sin clasificar".
 *   4. `columnaTenant: 'ninguna'` exige `motivoSinTenant` escrito. Sin motivo, no pasa.
 *
 * Se declara con `as const satisfies` (no con una anotación ancha) a propósito: así los literales
 * sobreviven y el tipo de campos loggeables se puede DERIVAR de acá en vez de repetirse a mano.
 */

import type { FormaDeEnmascarar, NivelDato } from './niveles.ts';

export type ClasificacionCampo = {
  readonly nivel: NivelDato;
  /** Cómo se muestra en un listado o en una vista de conjunto. */
  readonly enmascarar?: FormaDeEnmascarar;
  /** Cifrado a nivel aplicación (envelope). Obligatorio en N3 (ADR-0002 §A.1). */
  readonly cifrado?: boolean;
  /** Si puede salir en un export declarado y auditado. N3 nunca. */
  readonly exportable: boolean;
  readonly nota?: string;
};

export type ClasificacionTabla = {
  /** La columna que aísla la fila. `'ninguna'` exige motivo. */
  readonly columnaTenant: 'cliente_id' | 'estudio_id' | 'ninguna';
  readonly motivoSinTenant?: string;
  readonly campos: { readonly [columna: string]: ClasificacionCampo };
};

const UUID_INTERNO = { nivel: 'N1', exportable: true } as const satisfies ClasificacionCampo;
const MARCA_TIEMPO = { nivel: 'N1', exportable: true } as const satisfies ClasificacionCampo;

export const CLASIFICACION = {
  // ---------------------------------------------------------------------------
  // Tenancía. No lleva `cliente_id` porque ES el árbol de clientes: su aislamiento
  // se resuelve por `id in (select app.accessible_tenant_ids())`, no por una columna.
  // ---------------------------------------------------------------------------
  tenant_node: {
    columnaTenant: 'ninguna',
    motivoSinTenant:
      'Es la tabla del árbol de tenancía: su propia fila ES el tenant. Se aísla con ' +
      'id in (select app.accessible_tenant_ids()), no con una columna de tenant. Ver ADR-0001 §3.',
    campos: {
      id: UUID_INTERNO,
      nid: {
        nivel: 'N1',
        exportable: false,
        nota: 'Bigint secuencial: NUNCA sale en API, URL ni export — enumera la plataforma (R25).',
      },
      parent_id: UUID_INTERNO,
      tipo: { nivel: 'N1', exportable: true },
      nombre: {
        nivel: 'N2',
        exportable: true,
        nota: 'Razón social del cliente o nombre del estudio. Del estudio es N1; del cliente es N2. ' +
          'Se clasifica por el caso más sensible.',
      },
      path: { nivel: 'N1', exportable: false, nota: 'Contiene nid: no sale (R25).' },
      deleted_at: MARCA_TIEMPO,
      created_at: MARCA_TIEMPO,
      updated_at: MARCA_TIEMPO,
    },
  },

  membership: {
    columnaTenant: 'ninguna',
    motivoSinTenant:
      'Se aísla por tenant_node_id in (select app.accessible_tenant_ids()): el nodo al que pertenece ' +
      'la membresía ES la frontera. Ver ADR-0001 §4.1.',
    campos: {
      id: UUID_INTERNO,
      user_id: UUID_INTERNO,
      tenant_node_id: UUID_INTERNO,
      rol: { nivel: 'N1', exportable: true },
      activo: { nivel: 'N1', exportable: true },
      created_at: MARCA_TIEMPO,
    },
  },

  // ---------------------------------------------------------------------------
  // Auditoría de acceso (ADR-0002 §C.0 / R32). Append-only.
  // ---------------------------------------------------------------------------
  acceso_auditoria: {
    columnaTenant: 'cliente_id',
    campos: {
      id: { nivel: 'N1', exportable: true },
      cliente_id: UUID_INTERNO,
      user_id: UUID_INTERNO,
      accion: { nivel: 'N1', exportable: true },
      recurso: { nivel: 'N1', exportable: true, nota: 'Nombre de tabla u objeto, NUNCA su contenido.' },
      recurso_id: UUID_INTERNO,
      motivo: {
        nivel: 'N2',
        exportable: true,
        nota: 'Texto libre escrito por una persona: puede mencionar al cliente. Se trata como N2.',
      },
      correlacion: {
        nivel: 'N1',
        exportable: true,
        nota:
          'Identificador opaco que genera la aplicación para correlacionar el rastro con los logs. ' +
          'Existe porque `insert ... returning` no sirve en una tabla append-only: RETURNING aplica ' +
          'la policy de SELECT y quien escribe el rastro no puede leerlo (migración 0003).',
      },
      ocurrido_en: MARCA_TIEMPO,
    },
  },

  // ---------------------------------------------------------------------------
  // Credenciales fiscales (ADR-0002 §E.2). La única tabla N3 del sistema.
  // ---------------------------------------------------------------------------
  credencial_fiscal: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      servicio: { nivel: 'N1', exportable: true },
      ambiente: { nivel: 'N1', exportable: true, nota: 'homologacion | produccion' },
      material_cifrado: {
        nivel: 'N3',
        cifrado: true,
        exportable: false,
        nota:
          'Clave privada / credencial, cifrada con envelope. app_request NO tiene privilegio de ' +
          'SELECT sobre esta columna (grant a nivel columna). Solo el proceso firmador.',
      },
      kek_id: { nivel: 'N1', exportable: false, nota: 'Identificador de la clave maestra, no la clave.' },
      alg: { nivel: 'N1', exportable: false },
      fingerprint_sha256: {
        nivel: 'N2',
        enmascarar: 'huella',
        exportable: true,
        nota: 'Huella del certificado PÚBLICO: identifica la credencial sin descifrar nada.',
      },
      vence_en: {
        nivel: 'N2',
        exportable: true,
        nota:
          'Dato configurable por credencial, NO una constante: el plazo lo fija el organismo y esa ' +
          'fuente no está cargada (ADR-0002 §G, G-6).',
      },
      rotada_en: MARCA_TIEMPO,
      created_at: MARCA_TIEMPO,
    },
  },

  credencial_fiscal_rotacion: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      credencial_id: UUID_INTERNO,
      motivo: { nivel: 'N2', exportable: true },
      fingerprint_anterior: { nivel: 'N2', enmascarar: 'huella', exportable: true },
      rotada_por: UUID_INTERNO,
      ocurrido_en: MARCA_TIEMPO,
    },
  },

  // ---------------------------------------------------------------------------
  // MÓDULO 1 — ingesta de extractos bancarios (`0004_ingesta.sql`).
  //
  // El reparto de niveles de estas siete tablas ES una decisión de diseño, no una etiqueta puesta al
  // final: define qué lecturas quedan bajo régimen auditado. Ver plan §7.1.
  // ---------------------------------------------------------------------------

  banco: {
    columnaTenant: 'ninguna',
    motivoSinTenant:
      'Catálogo N0 de los bancos que el sistema sabe leer, con las capacidades declaradas de cada ' +
      'adapter. No contiene datos de ningún cliente: es conocimiento del producto. Se escribe por ' +
      'migración, no por la aplicación.',
    campos: {
      codigo: { nivel: 'N0', exportable: true },
      nombre: { nivel: 'N0', exportable: true },
      capacidades: {
        nivel: 'N0',
        exportable: true,
        nota: 'Qué publica el banco (saldo por fila, totales, columnas separadas). Sin esto, "el banco ' +
          'no publica el signo" y "el adapter está roto" son indistinguibles.',
      },
      activo: { nivel: 'N0', exportable: true },
      created_at: MARCA_TIEMPO,
    },
  },

  cuenta_bancaria: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      banco_codigo: { nivel: 'N1', exportable: true },
      moneda: { nivel: 'N1', exportable: true },
      alias: {
        nivel: 'N2',
        exportable: true,
        nota: 'Etiqueta que le pone el estudio ("sueldos", "cuenta del socio"). La elige una persona y ' +
          'dice más de lo que parece.',
      },
      abierta_desde: { nivel: 'N2', exportable: true },
      cerrada_en: { nivel: 'N2', exportable: true },
      created_at: MARCA_TIEMPO,
    },
  },

  cuenta_bancaria_identificador: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      cuenta_bancaria_id: UUID_INTERNO,
      tipo_cuenta: { nivel: 'N1', exportable: true },
      numero: {
        nivel: 'N2R',
        enmascarar: 'ultimos4',
        exportable: true,
        nota: 'N2R: hace falta ENTERO para hablar con el banco, así que no se puede hashear. El control ' +
          'NO es grant por columna (la primera versión de 0004 lo intentó y dejaba la tabla ilegible ' +
          'incluso para el contador): es policy con chequeo de rol en LECTURA más lector auditado.',
      },
      cbu_hmac: {
        nivel: 'N1',
        exportable: false,
        nota: 'HMAC con pepper de servidor. NO es el CBU. Con pepper y no hash pelado porque un CBU ' +
          'tiene entropía baja y un sha256 sin pepper se revierte con un diccionario.',
      },
      cbu_ultimos4: { nivel: 'N2', enmascarar: 'ultimos4', exportable: true },
      pepper_id: {
        nivel: 'N1',
        exportable: false,
        nota: 'Versión del pepper con el que se calculó cbu_hmac. Es un identificador de versión, NUNCA ' +
          'el pepper ni parte de él. Permite rotar sin volver a pedir el CBU (migración 0006).',
      },
      vigente_desde: { nivel: 'N1', exportable: true },
      vigente_hasta: { nivel: 'N1', exportable: true },
      created_at: MARCA_TIEMPO,
    },
  },

  lote_ingesta: {
    columnaTenant: 'cliente_id',
    campos: {
      // NI UNA COLUMNA ≥ N2, a propósito: si el lote llevara un dato N2, observar el pipeline (contar
      // lotes, ver cuántos fallaron) pasaría al régimen auditado y una de las dos cosas se degradaría.
      // Por eso el nombre original del archivo NO se guarda acá.
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      banco_codigo: { nivel: 'N1', exportable: true },
      adaptador_version: { nivel: 'N1', exportable: true },
      origen: { nivel: 'N1', exportable: true },
      archivo_clave: {
        nivel: 'N1',
        exportable: false,
        nota: 'cliente/<uuid>/extracto/<lote_uuid>.pdf. Lleva el ID del lote y NO el hash del ' +
          'contenido: una clave con el hash haría del storage un oráculo de "¿tenés este archivo?".',
      },
      archivo_hash: {
        nivel: 'N1',
        exportable: false,
        nota: 'Digest opaco del contenido, para idempotencia. Se compara SOLO dentro del cliente.',
      },
      paginas_declaradas: { nivel: 'N1', exportable: true },
      paginas_sin_texto: { nivel: 'N1', exportable: true },
      filas_leidas: { nivel: 'N1', exportable: true },
      filas_aceptadas: { nivel: 'N1', exportable: true },
      filas_rechazadas: { nivel: 'N1', exportable: true },
      estado: { nivel: 'N1', exportable: true },
      motivo_codigo: {
        nivel: 'N1',
        exportable: true,
        nota: 'CÓDIGO del vocabulario cerrado, nunca un mensaje: un mensaje armado desde el archivo ' +
          'filtra su contenido al log.',
      },
      motivo_codigo_previo: {
        nivel: 'N1',
        exportable: true,
        nota: 'CÓDIGO del vocabulario cerrado, el motivo_codigo que tenía el lote antes de remediarse ' +
          '(completar-lote.ts, HANDOFF 2026-08-11 (42)). NULL si el lote nunca se remedió.',
      },
      procesado_por: UUID_INTERNO,
      created_at: MARCA_TIEMPO,
    },
  },

  lote_ingesta_cuenta: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      lote_ingesta_id: UUID_INTERNO,
      cuenta_bancaria_id: UUID_INTERNO,
      periodo_desde: { nivel: 'N2', exportable: true },
      periodo_hasta: { nivel: 'N2', exportable: true },
      moneda: { nivel: 'N1', exportable: true },
      saldo_inicial_declarado: { nivel: 'N2', exportable: true },
      saldo_final_declarado: { nivel: 'N2', exportable: true },
      total_creditos_declarado: { nivel: 'N2', exportable: true },
      total_debitos_declarado: { nivel: 'N2', exportable: true },
      saldo_final_calculado: { nivel: 'N2', exportable: true },
      total_creditos_calculado: { nivel: 'N2', exportable: true },
      total_debitos_calculado: { nivel: 'N2', exportable: true },
      filas_leidas: { nivel: 'N1', exportable: true },
      filas_aceptadas: { nivel: 'N1', exportable: true },
      verificacion_estado: { nivel: 'N1', exportable: true },
      verificacion_detalle: {
        nivel: 'N1',
        exportable: true,
        nota: 'Códigos de diferencia y números de fila. NINGUNA diferencia lleva un valor: el ' +
          'diagnóstico no puede ser el canal de fuga.',
      },
      created_at: MARCA_TIEMPO,
    },
  },

  movimiento_bancario_crudo: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      lote_ingesta_id: UUID_INTERNO,
      cuenta_bancaria_id: UUID_INTERNO,
      fila_numero: { nivel: 'N1', exportable: true },
      fila_hash: {
        nivel: 'N2',
        exportable: false,
        nota: 'Digest de los campos de la fila. No es reversible, pero SÍ es comparable: publicarlo ' +
          'permitiría preguntar "¿tenés esta operación?" desde afuera.',
      },
      fecha: { nivel: 'N2', exportable: true },
      fecha_valor: { nivel: 'N2', exportable: true },
      descripcion: {
        nivel: 'N2',
        exportable: true,
        nota: 'La glosa del banco. Trae nombres de contrapartes y CUIT de terceros: es lo que INV-13 ' +
          'verifica que no salga por un log.',
      },
      importe: { nivel: 'N2', exportable: true },
      saldo: { nivel: 'N2', exportable: true },
      saldo_es_acreedor: { nivel: 'N1', exportable: true },
      moneda: { nivel: 'N1', exportable: true },
      concepto_codigo: {
        nivel: 'N1',
        exportable: true,
        nota: 'Código de concepto del banco. Es lo que permite clasificar por código en vez de por ' +
          'texto libre de la glosa — tres de las catorce reglas de la contadora fallan por eso.',
      },
      concepto_banco: {
        nivel: 'N2',
        exportable: true,
        nota:
          'El literal de concepto del banco, cortado de la MISMA glosa ya depurada que produce ' +
          '`descripcion`. Es N2 y NO N1 —medido contra los tres vocabularios—: en un banco del roster el ' +
          '73 % del archivo son `TPUSH <nombre>` (569) y `TRANSF <nombre>` (409), y su vocabulario trae el ' +
          'sufijo `DOC<11 dígitos>` que es el documento de la contraparte; en otro el concepto se trunca a ' +
          '27 y sigue en la línea siguiente, que es donde vive la contraparte. Solo en el tercero la ' +
          'etiqueta viene sola. Se mantiene en N2 y NO en N2R por INV-14: el check ' +
          '`mov_crudo_concepto_prefijo_chk` (migración 0007) exige que sea prefijo de `descripcion`, así ' +
          'que hereda la garantía de INV-13 POR CONSTRUCCIÓN. Si alguien lo pone N2R, ' +
          '`tablasQueExigenRolEnLectura()` suma esta tabla sola y toda lectura de movimientos pasa al ' +
          'régimen auditado — auditar cada pantalla es el ruido que destruye la detección del acceso ' +
          'masivo real.',
      },
      concepto_completo: {
        nivel: 'N1',
        exportable: true,
        nota:
          'Hecho del PARSEO, no del valor: si el concepto entró entero o lo cortó el ancho de la columna. ' +
          'No dice nada de ningún tercero — es una propiedad del layout del banco, la misma para todos sus ' +
          'clientes, igual que `saldo_es_acreedor`. No es oráculo: no recupera nada del valor y no es ' +
          'comparable (a diferencia de `fila_hash`, que es N2 justamente por serlo). Tiene que ser N1 para ' +
          'que "el adaptador está truncando todo" se pueda diagnosticar por log y por métrica sin auditar ' +
          'una lectura. El concepto más frecuente de un extracto medido son 78 movimientos con 14 ' +
          'caracteres: sin este bit no se sabe si está completo, y el corte es geométrico, no de ' +
          'caracteres. NO es reconstruible después.',
      },
      concepto_banco_estrategia: {
        nivel: 'N1',
        exportable: true,
        nota:
          'Unión cerrada que declara de dónde salió el corte de `concepto_banco` (INV-14), para que la ' +
          'procedencia sea auditable en los datos y no solo en un test. `no_capturado` es el valor del ' +
          'backfill de 0007 y ningún adaptador lo emite: sin él, "el banco no publica concepto" y "esta ' +
          'fila es anterior a 0007" se ven iguales para siempre y el léxico del Módulo 2 las cuenta ' +
          'juntas. Es vocabulario del producto, no dato de nadie.',
      },
      pagina_pdf: {
        nivel: 'N1',
        exportable: true,
        nota:
          'Página del documento de la que salió la fila. Estaba en el esquema y NO se persistía: de un ' +
          'movimiento guardado no se podía volver a su página. Es un hecho de la extracción, no se deriva ' +
          'de nada guardado, y es el puntero de evidencia del asiento propuesto — la diferencia entre "el ' +
          'sistema dice esto" y "el sistema dice esto, y acá está de dónde lo sacó".',
      },
      referencia_externa: { nivel: 'N2', exportable: true },
      created_at: MARCA_TIEMPO,
    },
  },

  /**
   * El bloque que NO son movimientos (`0008_anexos.sql`).
   *
   * Ni una columna N2R, y es una decisión: si el literal del banco pudiera traer un identificador de un
   * tercero, esta tabla exigiría rol en lectura y lector auditado. El check
   * `anexo_literal_sin_identificador_chk` de la migración es lo que evita que haga falta.
   */
  anexo_extracto: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      lote_ingesta_id: UUID_INTERNO,
      cuenta_bancaria_id: UUID_INTERNO,
      atribucion_cuenta: {
        nivel: 'N1',
        exportable: true,
        nota:
          'Unión cerrada: por qué esta fila tiene (o no tiene) cuenta. La atribución del anexo a su ' +
          'cuenta NO es posicional — un banco reparte su renglón computable 0/2/1 entre 3 cuentas y otro ' +
          'publica sus dos bloques después del último saldo de las dos. Existe para que "no sé de qué ' +
          'cuenta es" no se pueda leer como "es del lote entero".',
      },
      orden_en_lote: {
        nivel: 'N1',
        exportable: true,
        nota:
          'Ordinal en orden de lectura. ES la identidad de la fila: el anexo no tiene clave natural (un ' +
          'banco imprime el mismo literal con dos espaciados y tiene 3 renglones que pueden compartir ' +
          'período). A diferencia de `fila_hash`, no tiene que sobrevivir a un reproceso: la ' +
          'idempotencia entre ingestas la da `lote_ingesta.unique (cliente_id, archivo_hash)`.',
      },
      pagina_pdf: {
        nivel: 'N1',
        exportable: true,
        nota:
          'Hecho de la extracción. Para el renglón que cruza el corte de página —el único elemento del ' +
          'documento que se parte— es la página donde arranca la ETIQUETA, no donde cae el importe.',
      },
      concepto_literal: {
        nivel: 'N2',
        exportable: true,
        nota:
          'El rótulo tal como lo imprime el banco, SIN normalizar (un banco publica el mismo literal con ' +
          'dos espaciados en el mismo archivo: son dos grafías reales, y normalizar es del léxico del ' +
          'Módulo 2, que es código). Es N2 y no N2R por una razón distinta de la de `concepto_banco`: un ' +
          'anexo es un totalizador impositivo, no una transacción — no hay contraparte por construcción, ' +
          'y ninguno de los literales medidos en los tres bancos lleva una. Pero "no hay caso medido" no ' +
          'es garantía y acá no hay `descripcion` de la cual ser prefijo, así que la garantía es una ' +
          'puerta de admisión: `anexo_literal_sin_identificador_chk` rechaza toda corrida de 7+ dígitos ' +
          '(la clase más corta de `glosa.ts`). Medido: la corrida más larga en el material real es de 5.',
      },
      periodo_desde: {
        nivel: 'N2',
        exportable: true,
        nota:
          'Nullable: un banco publica una variante inline SIN fecha de inicio, y tres de los cinco ' +
          'conceptos del detalle impositivo de otro no traen fechas. Qué clase de ausencia es lo dice ' +
          '`periodo_dato`.',
      },
      periodo_hasta: { nivel: 'N2', exportable: true },
      periodo_dato: {
        nivel: 'N1',
        exportable: true,
        nota:
          'Cuál de las cuatro situaciones medidas es. `periodo_de_emision` (el banco declara que es el ' +
          'período del extracto sin imprimirlo) NO es `no_publicado`. Ninguno de los dos autoriza a ' +
          'copiar el período del extracto: el bloque cubre períodos DISTINTOS, y rellenarlo es un hecho ' +
          'fiscal fabricado que cuadra.',
      },
      importe_declarado: {
        nivel: 'N2',
        exportable: true,
        nota:
          'Plata del titular. No se llama `importe` a propósito: un `sum(importe)` o un `union all` ' +
          'copiado del query de movimientos no compila. Y es NO SIGNADO contra el importe signado del ' +
          'movimiento, para que una suma cruzada dé basura visible en vez de un total plausible.',
      },
      moneda: { nivel: 'N1', exportable: true },
      alicuota_publicada: {
        nivel: 'N2',
        exportable: true,
        nota:
          'N2 y NO N1, contra la intuición de que "una alícuota la fija el Estado". El material lo ' +
          'desmiente: los bloques de tasas de dos bancos del roster no son alícuotas legales — son la ' +
          'tasa que ese banco le cobra a ESE cliente por su descubierto: precio negociado. Una columna ' +
          'no puede ser N1 para el impuesto y N2 para la TNA: se clasifica por el caso peor. Es el ' +
          'LITERAL publicado, nunca un número parseado (una tasa en float es el mismo error que un ' +
          'importe en float).',
      },
      relacion_con_movimientos: {
        nivel: 'N1',
        exportable: true,
        nota:
          'INV-15. Convierte "prohibido que entre en la suma de movimientos" —una prohibición que nadie ' +
          'puede chequear— en una condición sobre una columna. Medido: el detalle impositivo de un banco ' +
          'resume los impuestos que YA están como movimientos; sumarlo cuenta el impuesto dos veces y el ' +
          'asiento cuadra igual. Solo `no_esta_en_los_movimientos` es candidato a registración; ' +
          '`no_determinada` se trata como `resume_movimientos_del_cuerpo` (fail-closed).',
      },
      created_at: MARCA_TIEMPO,
    },
  },

  movimiento_origen_crudo: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      movimiento_id: UUID_INTERNO,
      fila_origen: {
        nivel: 'N2R',
        exportable: true,
        nota: 'La fila cruda sin interpretar. N2R porque contiene los datos de TERCEROS de la ' +
          'contraparte (113 CUIT en un solo archivo del piloto), que no son clientes del estudio y ' +
          'nunca consintieron nada.',
      },
      created_at: MARCA_TIEMPO,
    },
  },
} as const satisfies Record<string, ClasificacionTabla>;

export type NombreTabla = keyof typeof CLASIFICACION;

// -----------------------------------------------------------------------------
// Derivaciones. Nadie repite estas listas a mano.
// -----------------------------------------------------------------------------

/**
 * Nombres de columna de nivel ≥ N2, DERIVADOS del registro a nivel de tipo.
 * Es lo que hace que el logger rechace `{ material_cifrado: ... }` en tiempo de compilación.
 */
export type ColumnaSensible = {
  [T in NombreTabla]: {
    [C in keyof (typeof CLASIFICACION)[T]['campos']]: (typeof CLASIFICACION)[T]['campos'][C] extends {
      nivel: 'N0' | 'N1';
    }
      ? never
      : C;
  }[keyof (typeof CLASIFICACION)[T]['campos']];
}[NombreTabla];

/** La misma lista, en runtime. El test verifica que tipo y runtime no divergen. */
export const COLUMNAS_SENSIBLES: ReadonlySet<string> = new Set(
  Object.values(CLASIFICACION).flatMap((tabla) =>
    Object.entries(tabla.campos)
      .filter(([, campo]) => campo.nivel !== 'N0' && campo.nivel !== 'N1')
      .map(([columna]) => columna),
  ),
);

/**
 * Nombres de columna que ADEMÁS son sensibles en cualquier contexto, aunque la clave venga de otra
 * fuente (un payload externo, un CSV, una respuesta de webservice). Se agregan a mano porque no son
 * columnas nuestras: son formas en las que un dato sensible llega disfrazado.
 */
export const CLAVES_SENSIBLES_EXTERNAS = [
  'cuit',
  'cuil',
  'cbu',
  'alias',
  'alias_cbu',
  'numero_cuenta',
  'nro_cuenta',
  'importe',
  'monto',
  'saldo',
  /**
   * El saldo **consolidado por moneda** de la carátula, y sus grafías.
   *
   * Es N2 —agregar los saldos de un titular sigue siendo el dato de ese titular— y viaja en forma canónica
   * (`-98765.43`), que **ningún detector del redactor tapa**: el de importes está limitado al formato local
   * `1.234,56`. O sea que sin estas entradas, `logger.info('x', { consolidado_ars: … })` compila, pasa el
   * redactor y publica el saldo del cliente.
   *
   * Es el mismo hueco que ya tuvo `saldoFinal` una vez: la lista se escribió antes de que el campo
   * existiera. Se agregan también las grafías **camelCase**, porque `ClaveProhibida` compara literales
   * exactos y los nombres del código TypeScript no son snake_case.
   */
  'consolidado',
  'consolidados',
  'consolidado_por_moneda',
  'consolidados_por_moneda',
  'consolidadosPorMoneda',
  'saldo_consolidado',
  'saldoConsolidado',
  'importe_declarado',
  'importeDeclarado',
  'descripcion',
  'glosa',
  'concepto',
  'razon_social',
  'razonsocial',
  'domicilio',
  'password',
  'contrasena',
  'clave',
  'clave_fiscal',
  'token',
  'authorization',
  'secret',
  'private_key',
  'clave_privada',
  'certificado',
  'dsn',
  'database_url',
  'remuneracion',
  'sueldo',

  // ---------------------------------------------------------------------------
  // Campos del Módulo 1 (ingesta bancaria).
  //
  // ⚠️ POR QUÉ HAY QUE ENUMERARLOS: `esClaveSensible` compara por **pertenencia exacta** al conjunto
  // normalizado, no por subcadena. `saldo` estaba en la lista y `saldoFinal` NO; `importe` estaba y
  // `credito`/`debito` NO. Combinado con la ausencia de un detector de importe, esto compilaba, pasaba
  // el redactor y **publicaba el saldo del cliente en el log**:
  //
  //     logger.info('ingesta.cuenta', { saldoFinal: cuenta.saldoFinal })
  //
  // Hallazgo H-C de `seguridad-datos-financieros`. Y la lección de fondo: **un blocklist de nombres
  // pierde siempre contra el próximo campo.** Por eso el arreglo de verdad es `loggerAcotado()`
  // —allowlist cerrada, verificada en compilación— y esto es la red de abajo.
  // ---------------------------------------------------------------------------
  'saldo_inicial',
  'saldo_final',
  'saldo_anterior',
  'saldo_declarado',
  'credito',
  'debito',
  'total_creditos',
  'total_debitos',
  'denominacion',
  'referencia_externa',
  'referencia',
  'fila_origen',
  'fila_hash',
  'lineas',
  'linea',
  'descripcion_lineas',
  'texto',
  'texto_crudo',
  'nombre_archivo',
  'archivo',
  'ruta',
  'titular',
  'contraparte',
  'contraparte_nombre',
  'contraparte_documento',
  'ordenante',
  'beneficiario',
  'documento',
  'dni',
  'cotizacion',
  /**
   * 🔴 Agregadas por la auditoría de `security-engineer` (2026-08-10). **No estaban en NINGUNA de las
   * dos listas**, así que no las tapaba ni el tipo ni el redactor en runtime.
   *
   * La peor es `titular_documento`: el detector de CUIT exige prefijo 20/23/…/34 con 11 dígitos, y
   * **no hay ningún detector de DNI** — 7 u 8 dígitos pelados pasan los tres patrones. O sea que
   * `logger.info('x', { titularDocumento: … })` compilaba, pasaba el filtro de clave y pasaba todos
   * los detectores. Lo mismo con el `valor` de un `candidatoIdentificacion` de tipo `dni`.
   */
  'titular_documento',
  'titular_condicion_iva',
  'contraparte_banco',
  'glosa_original',
  'candidatos_identificacion',
  'identificadores',
] as const satisfies readonly string[];

/**
 * `snake_case` → `camelCase` **a nivel de tipo**. Es lo que hace que la lista sea UNA.
 *
 * ## El agujero que cierra
 *
 * `ClaveProhibida` compara **literales exactos**, y las dos listas de claves están escritas en
 * snake_case —que son los nombres de las **columnas**—. Pero los nombres que existen en el código
 * TypeScript son camelCase, así que `logger.info('x', { saldoFinalDeclarado: … })` **compilaba**.
 *
 * El redactor lo tapaba en runtime (`normalizarClave` saca los `_`), o sea que no había fuga. Lo que
 * se perdía es **R27**: *"el logger no compila si le pasás una clave ≥ N2"*. R27 es la defensa; el
 * redactor es la red — y una red sin defensa es la mitad del control.
 *
 * Y el agujero era peor de lo que parecía: la lista del logger **también había divergido en
 * snake_case**, con ~32 claves que el redactor tapa y el tipo nunca conoció. La ironía que lo
 * dimensiona está en `packages/data/src/ingesta/escrituras.ts`, que celebra que *"el tipo del logger
 * rechazó `cbu_ultimos4`"*: cierto, pero el campo se llama **`cbuUltimos4`** y en esa grafía compilaba.
 *
 * **Derivar en vez de mantener dos listas** es la misma lección que este repo ya aplicó tres veces con
 * los enums del dominio contra sus `check`.
 */
export type ACamel<S extends string> = S extends `${infer Cabeza}_${infer Resto}`
  ? `${Cabeza}${Capitalize<ACamel<Resto>>}`
  : S;

type ClaveExterna = (typeof CLAVES_SENSIBLES_EXTERNAS)[number];

/**
 * **Toda** clave sensible, en las dos grafías. Es la única fuente: el logger la importa y no mantiene
 * ninguna lista propia.
 */
export type ClaveSensible =
  | ColumnaSensible
  | ACamel<ColumnaSensible>
  | ClaveExterna
  | ACamel<ClaveExterna>;

export function nivelDe(tabla: NombreTabla, columna: string): NivelDato | undefined {
  const campos: Record<string, ClasificacionCampo> = CLASIFICACION[tabla].campos;
  return campos[columna]?.nivel;
}

export function tablasConColumnaTenant(): NombreTabla[] {
  return (Object.keys(CLASIFICACION) as NombreTabla[]).filter(
    (t) => CLASIFICACION[t].columnaTenant !== 'ninguna',
  );
}

/** Tablas que exigen chequeo de ROL también en la política de SELECT (ADR-0002 §B, item 4 de §H.3). */
export function tablasQueExigenRolEnLectura(): NombreTabla[] {
  return (Object.keys(CLASIFICACION) as NombreTabla[]).filter((t) =>
    Object.values(CLASIFICACION[t].campos).some((c) => c.nivel === 'N2R' || c.nivel === 'N3'),
  );
}

/** Columnas que app_request NO debe poder ni seleccionar (grant a nivel columna). */
export function columnasSoloFirmador(): { tabla: NombreTabla; columna: string }[] {
  return (Object.keys(CLASIFICACION) as NombreTabla[]).flatMap((tabla) =>
    Object.entries(CLASIFICACION[tabla].campos)
      .filter(([, campo]) => campo.nivel === 'N3')
      .map(([columna]) => ({ tabla, columna })),
  );
}
