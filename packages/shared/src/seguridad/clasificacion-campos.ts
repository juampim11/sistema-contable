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
      parent_path: {
        nivel: 'N1',
        exportable: false,
        nota:
          'Espejo del `path` del padre (0017). Mismo criterio que `path`: contiene nid, no sale (R25). ' +
          'No es un dato: es lo que vuelve fila-local el invariante del árbol, y por lo tanto ' +
          'verificable con un CHECK inmune a la RLS. Su veracidad la sostiene tenant_node_parent_path_fk.',
      },
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

  /**
   * Rastro append-only de los cambios del padrón de derechos (incidente #5, `0019`).
   *
   * Mismo plano que `membership`: se aísla por el nodo, no por `cliente_id`. Y mismo criterio de
   * nivel — quién tiene qué rol sobre qué nodo es estructura de la plataforma, no dato de un cliente.
   */
  membership_historia: {
    columnaTenant: 'ninguna',
    motivoSinTenant:
      'Igual que `membership`: se aísla por tenant_node_id in (select app.accessible_tenant_ids()). ' +
      'Una membresía de socio, auditor o admin_plataforma cuelga del ESTUDIO, no de un cliente — que ' +
      'es exactamente por lo que este rastro no puede vivir en `acceso_auditoria` (su trigger exige ' +
      'un nodo de tipo cliente y la fila no entra).',
    campos: {
      id: UUID_INTERNO,
      tenant_node_id: UUID_INTERNO,
      membership_id: UUID_INTERNO,
      user_id: UUID_INTERNO,
      rol: { nivel: 'N1', exportable: true },
      operacion: { nivel: 'N1', exportable: true },
      activo_antes: { nivel: 'N1', exportable: true },
      activo_despues: { nivel: 'N1', exportable: true },
      hecho_por: UUID_INTERNO,
      ocurrido_en: MARCA_TIEMPO,
      via_depth: {
        nivel: 'N1',
        exportable: true,
        nota:
          'Profundidad de trigger con la que se escribió la fila (`0020` §3). No es un dato del ' +
          'negocio: es el mecanismo que distingue la fila del trigger (vale 1) de una escrita a mano ' +
          '(el DEFAULT vale 0 fuera de un trigger y el check la rechaza). Se expone sin problema — no ' +
          'dice nada de nadie.',
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Auditoría de acceso (ADR-0002 §C.0 / R32). Append-only.
  // ---------------------------------------------------------------------------
  acceso_auditoria: {
    columnaTenant: 'cliente_id',
    campos: {
      id: {
        nivel: 'N1',
        exportable: false,
        nota:
          'Bigint secuencial GLOBAL — la MISMA forma que `tenant_node.nid`, y por lo tanto el mismo ' +
          'trato: NUNCA sale en API, URL ni export (R25). No hace falta enumerar: DOS filas propias ' +
          'alcanzan, porque la secuencia es de toda la plataforma y los huecos entre filas propias ' +
          'son el volumen de auditoría de los demás estudios. Es N1 y NO N2 porque no revela dato de ' +
          'ningún cliente sino actividad de la plataforma —mismo criterio que `nid`, `path` y ' +
          '`parent_path`—, y porque este registro clasifica por NOMBRE de columna: `id` en N2 ' +
          'rompería la compilación del logger en todo el repo y haría que `redactar` tape todo `id` ' +
          'de todo log. `0020` §1 le revoca además el `insert`: con `overriding system value` un ' +
          'tenant reclama ids que la secuencia no alcanzó y la PK aborta la operación auditada de ' +
          'OTRO tenant (incidente #7, medido). La mitad FUGA sigue abierta (hallazgo H-A): cerrarla ' +
          'es cambiar el tipo de la PK de una tabla append-only.',
      },
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
      entrada_digest: {
        nivel: 'N2',
        exportable: false,
        nota: 'Digest de los SIETE campos que el motor lee de esta fila (0021). Mismo criterio y mismo ' +
          'nivel que fila_hash, y por el mismo motivo: no es reversible pero SÍ es comparable. ⚠️ NO lleva ' +
          'pepper —una columna generada no puede leer un secreto de entorno—, así que la misma glosa da el ' +
          'mismo digest en dos clientes del mismo estudio. El riesgo está acotado, no cerrado: correlacionar ' +
          'exige acceso RLS a los DOS tenants, y quien lo tiene ya puede correlacionar por concepto_banco ' +
          '(N2, sin lectura auditada) con mejor resolución. Revisitar el día que exista un rol que vea la ' +
          'cola de revisión SIN ver los movimientos crudos.',
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
      contraparte_captura: {
        nivel: 'N1',
        exportable: true,
        nota:
          'Unión cerrada que declara si el backfill de contraparte (migración 0013) corrió sobre ' +
          'esta fila y con qué resultado — mismo patrón que `concepto_banco_estrategia` de la 0007. ' +
          'NO identifica a nadie: es vocabulario del producto. `capturado_cuenta_propia` es lo que ' +
          'le permite a la regla 10 (transferencia entre cuentas del mismo titular) resolver SIN ' +
          'comparar HMAC entre el espacio derivado por cliente y el global en tiempo de ejecución ' +
          'del motor — ver la nota de `movimiento_contraparte_identificador.hmac`.',
      },
      created_at: MARCA_TIEMPO,
    },
  },

  /**
   * Los candidatos de contraparte de cada movimiento (migración 0013). 0..N filas por movimiento:
   * ninguno está declarado como "la contraparte real" — elegir es del motor (capa C), no de la
   * ingesta.
   */
  movimiento_contraparte_identificador: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      movimiento_id: UUID_INTERNO,
      clase: {
        nivel: 'N1',
        exportable: true,
        nota:
          'Forma del identificador candidato (`cuit`|`dni`|`cbu`), no su valor — hecho de la ' +
          'EXTRACCIÓN, mismo criterio que `concepto_completo`. NO lleva `cuil`: un CUIT y un CUIL ' +
          'son el mismo número y `RE_CUIT` es un solo patrón para los dos, así que ningún ' +
          'extractor puede asignar esa etiqueta por forma — un valor que nadie puede producir es ' +
          'una mentira en el esquema.',
      },
      identificador_hmac: {
        nivel: 'N2',
        exportable: false,
        nota:
          'Seudónimo estable del identificador de un TERCERO que nunca consintió nada. Mismo ' +
          'mecanismo que `cuenta_bancaria_identificador.cbu_hmac` (N1), un escalón más arriba por ' +
          'ser de un tercero y no del titular: irreversible pero COMPARABLE — la propiedad que ' +
          'pone a `fila_hash` en N2 — y publicarlo permite preguntar "¿tenés esta operación?" y ' +
          'encadenar todos los movimientos de una misma contraparte DENTRO del cliente. El pepper ' +
          'derivado por cliente (hmacDocumento) cierra la correlación ENTRE clientes, no la de ' +
          'adentro; por eso sigue N2 y no baja a N1. Se mantiene en N2 y NO en N2R a propósito: ' +
          'si fuera N2R, `tablasQueExigenRolEnLectura()` sumaría esta tabla y toda pasada del ' +
          'motor pasaría al régimen auditado — el ruido que la enmienda 1 del Módulo 1 existe ' +
          'para evitar.',
      },
      pepper_id: {
        nivel: 'N1',
        exportable: false,
        nota:
          'Versión del pepper GLOBAL del que se derivó el efectivo de esta fila, NUNCA el pepper ' +
          'ni parte de él. Vive por fila —no en el movimiento— porque cada candidato se ' +
          'backfillea o se rota por separado, y durante una rotación conviven v1 y v2 del mismo ' +
          'movimiento.',
      },
      created_at: MARCA_TIEMPO,
    },
  },

  /**
   * Padrón de socios por cliente (migración 0013), con vigencia. Es contra esto que el motor
   * decide Proveedores/Deudores vs. Cuenta Particular. Partida en dos tablas: esta (N2, sin
   * columnas N2-R, consultada en cada pasada) y `padron_socio_documento` (N2-R, el documento en
   * claro, satélite).
   */
  padron_socio: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      denominacion: {
        nivel: 'N2',
        exportable: true,
        nota:
          'Nombre o razón social del socio, mismo criterio que `tenant_node.nombre`. Se mantiene ' +
          'en N2 por el check `padron_socio_denominacion_sin_identificador_chk` (puerta de ' +
          'admisión, no confianza): sin él, cargar un documento ahí por error dejaría el dato en ' +
          'claro de un tercero en una columna que se lee sin rol y sin auditoría.',
      },
      documento_tipo: {
        nivel: 'N1',
        exportable: true,
        nota:
          'Etiqueta documental (`cuit`|`cuil`), sin `dni` — un DNI no identifica a un socio ante ' +
          'ningún organismo. NO entra tal cual en el material hasheado: `cuit` y `cuil` canonizan ' +
          'al mismo dominio de hash (`hmacDocumento`), porque son el mismo número.',
      },
      documento_hmac: {
        nivel: 'N2',
        exportable: false,
        nota:
          'Comparable, no reversible: la clave contra la que el motor resuelve "¿esta contraparte ' +
          'es un socio?" sin leer ningún documento en claro. Pepper derivado por cliente.',
      },
      documento_ultimos4: { nivel: 'N2', enmascarar: 'ultimos4', exportable: true },
      pepper_id: {
        nivel: 'N1',
        exportable: false,
        nota: 'Versión del pepper global del que se derivó el efectivo. Ver la nota homónima de ' +
          '`movimiento_contraparte_identificador`.',
      },
      vigente_desde: {
        nivel: 'N2',
        exportable: true,
        nota:
          'Vigencia de una RELACIÓN SOCIETARIA ("desde cuándo esta persona es socia de este ' +
          'cliente"), no de un identificador técnico — por eso es N2 y no N1 como ' +
          '`cuenta_bancaria_identificador.vigente_desde`. Un socio entra y sale, y sin vigencia ' +
          'todos los retiros van al socio equivocado y el asiento cuadra igual.',
      },
      vigente_hasta: { nivel: 'N2', exportable: true },
      created_at: MARCA_TIEMPO,
    },
  },

  /**
   * Satélite N2-R de `padron_socio`: el documento en claro, un renglón por alta, inmutable. Existe
   * para que el pepper se pueda rotar y para que una persona verifique lo que cargó — el motor
   * NUNCA la consulta.
   */
  padron_socio_documento: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      socio_id: {
        nivel: 'N2',
        exportable: true,
        nota: '🔴 SUBIDA DE N1 A N2 EN 0021, y el motivo es del REGISTRO, no de esta tabla: el registro ' +
          'clasifica por NOMBRE DE COLUMNA globalmente (ColumnaSensible aplana el mapeo), y ' +
          'reconocimiento_contrapartida_match.socio_id es N2. Dejarla en N1 acá haría que el registro dijera ' +
          'DOS COSAS DEL MISMO NOMBRE — y el gate no lo detecta, porque redactor.test.ts tolera N1-en-una-tabla ' +
          'y N2-en-otra (precedente `motivo`). El nivel efectivo ya es N2 por la unión; esto lo hace explícito.',
      },
      documento: {
        nivel: 'N2R',
        enmascarar: 'cuit_parcial',
        exportable: true,
        nota:
          'El documento en claro de un tercero — mismo régimen que ' +
          '`movimiento_origen_crudo.fila_origen`. Se lee en un acto puntual (alta o corrección de ' +
          'un socio), nunca por pasada del motor.',
      },
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

  /**
   * El resultado del motor de reconocimiento (migración 0014). Qué dijo el motor sobre un
   * movimiento, con qué versión del código (`motor_digest`) y qué fila lo reemplazó.
   *
   * 🔴 NINGUNA columna N2-R, a propósito: la evidencia guarda el `id` de la entrada del léxico —que
   * es CÓDIGO, N0— y nunca el texto que matcheó (05 §6). Es lo que mantiene a esta tabla fuera del
   * régimen de lectura auditada, y es requisito de que la cola de revisión sea usable: se lista
   * entera, todos los meses. Auditar cada pasada sería el ruido de ADR-0002 H-8.
   */
  reconocimiento_movimiento: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      movimiento_id: UUID_INTERNO,
      superseded_por: UUID_INTERNO,
      motor_digest: {
        nivel: 'N1',
        exportable: true,
        nota: 'Identidad del ARTEFACTO DE CÓDIGO que produjo la fila (digestDeBanco), no dato del cliente.',
      },
      clase: { nivel: 'N1', exportable: true, nota: 'Vocabulario de proceso: qué trabajo le queda a la persona.' },
      es_propuesta: { nivel: 'N1', exportable: true, nota: 'Generada de `clase`. Destino de la FK de asiento_propuesto (0016+).' },
      tipo: {
        nivel: 'N2',
        exportable: true,
        nota: 'Clasificación contable de ESTA transacción de ESTE cliente — mismo nivel que asientos y partidas (ADR-0002 §A.1).',
      },
      concepto: { nivel: 'N2', exportable: true, nota: 'Ídem `tipo`: es la interpretación del movimiento del cliente.' },
      polaridad: { nivel: 'N1', exportable: true, nota: 'Hecho estructural (normal/reversa), mismo tier que saldo_es_acreedor.' },
      lado: { nivel: 'N1', exportable: true, nota: 'Hecho estructural: sale de columnaOrigen (04 §2).' },
      via: { nivel: 'N1', exportable: true, nota: 'Cuál matcher resolvió — hecho del PROCESO, mismo tier que concepto_banco_estrategia.' },
      que_decide: { nivel: 'N1', exportable: true, nota: 'Vocabulario cerrado sobre qué falta decidir, mismo tier que motivo_codigo.' },
      motivo_codigo: {
        nivel: 'N1',
        exportable: true,
        nota: 'MotivoSinReconocer, vocabulario cerrado. `_codigo` y no `motivo` a secas: ADR-0002 §C.0.bis documenta que ese nombre ya costó una vez.',
      },
      evidencia_entrada_lexico_id: {
        nivel: 'N2',
        exportable: true,
        nota: 'Id del léxico (código N0), pero determina el concepto del movimiento del cliente tan directamente como la columna `concepto`: se clasifica por lo que revela, no por la forma.',
      },
      evidencia_caracteres_matcheados: {
        nivel: 'N1',
        exportable: true,
        nota: 'Acotado por el largo del LITERAL del léxico (N0), no por el de la glosa. Si un matcher futuro lo hiciera el largo de la glosa, pasa a ser un oráculo sobre texto del cliente y hay que reclasificarlo.',
      },
      evidencia_hubo_cola: {
        nivel: 'N1',
        exportable: true,
        nota: 'Es `entrada.matcheo.modo === prefijo_con_cola`: propiedad de la ENTRADA DEL LÉXICO, no de la glosa. La cola en sí (el nombre de la contraparte) está prohibida por 05 §6.',
      },
      recalculo_disponible: { nivel: 'N1', exportable: true, nota: 'Booleano de workflow. Sin productor todavía.' },
      entrada_digest: {
        nivel: 'N2',
        exportable: false,
        nota: 'FOTO del movimiento_bancario_crudo.entrada_digest en el instante en que se emitió este ' +
          'reconocimiento (0021). Mismo nivel que su origen. La llena un trigger que COPIA, no la ' +
          'aplicación: no lleva grant de insert.',
      },
      created_at: MARCA_TIEMPO,
    },
  },

  /**
   * Satélite 0..N de `reconocimiento_movimiento` (migración 0014): las entradas del léxico a las
   * que apuntaba un reconocimiento que no se pudo resolver. Ids de código, nunca texto.
   */
  reconocimiento_candidato: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      reconocimiento_id: UUID_INTERNO,
      reconocimiento_clase: {
        nivel: 'N1',
        exportable: true,
        nota: 'Generada CONSTANTE (`sin_reconocer`). Mitad hija de la FK de tres columnas: no se puede escribir ni con el valor correcto.',
      },
      entrada_lexico_id: {
        nivel: 'N2',
        exportable: true,
        nota: 'Mismo criterio que reconocimiento_movimiento.evidencia_entrada_lexico_id.',
      },
      created_at: MARCA_TIEMPO,
    },
  },

  /**
   * La declaración de que el padrón de socios de un cliente está COMPLETO, con su alcance
   * (migración 0021). Es la premisa que habilita al motor a concluir «es un tercero».
   * Append-only: sin `update` ni `delete` para nadie, ni policy ni grant.
   */
  padron_manifestacion: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      revoca_a: UUID_INTERNO,
      completo_hasta: {
        nivel: 'N2',
        exportable: true,
        nota: 'La vigencia de una afirmación sobre la COMPOSICIÓN SOCIETARIA del cliente, no un parámetro ' +
          'técnico — mismo criterio y mismo nivel que padron_socio.vigente_desde.',
      },
      manifestado_por: {
        nivel: 'N1',
        exportable: true,
        nota: 'Uuid del usuario que declaró la sesión. ⚠️ NO es prueba de autoría: app.current_user_id() es ' +
          'un GUC que setea la propia sesión. Identidad declarada no es identidad autenticada — el límite ' +
          'está en el comment on column de 0021 y ninguna pantalla puede presentarlo como firma.',
      },
      manifestado_en: MARCA_TIEMPO,
    },
  },

  /**
   * Qué resolvió capa C sobre un movimiento (migración 0021): uno de los 7 estados de
   * `ResolucionDeContraparte`, con el vínculo a la manifestación en la que se apoyó. Una fila
   * por CADA evaluación — la presencia de fila ES el hecho de que capa C corrió.
   */
  reconocimiento_contrapartida: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      reconocimiento_id: UUID_INTERNO,
      padron_manifestacion_id: UUID_INTERNO,
      resolucion_estado: {
        nivel: 'N2',
        exportable: true,
        nota: 'La interpretación de ESTA transacción de ESTE cliente — mismo tier que reconocimiento_movimiento' +
          '.tipo y .concepto. 🔴 `resolucion_estado` y NUNCA `estado`: el registro clasifica por nombre de ' +
          'columna GLOBALMENTE, y una columna `estado` en N2 taparía lote_ingesta.estado, que es N1 a propósito.',
      },
      reconocimiento_clase: {
        nivel: 'N1',
        exportable: true,
        nota: 'Espejo de reconocimiento_movimiento.clase (N1), infalsificable por la FK de tres columnas contra ' +
          'uq_recon_clase. Vocabulario de proceso, no del cliente.',
      },
      admite_matches: {
        nivel: 'N2',
        exportable: true,
        nota: 'Generada. 🔴 NO hereda el nivel de su insumo: AÍSLA su bit de mayor contenido — `true` significa ' +
          '«hay evidencia positiva de que la contraparte de este movimiento es un socio del cliente». Es el ' +
          'hecho sensible, en un booleano. Con N1, logger.info(…, {movimiento_id, admite_matches: true}) ' +
          'compilaría y publicaría eso a un almacén sin RLS.',
      },
      regimen_matches: {
        nivel: 'N2',
        exportable: true,
        nota: 'Generada, tres valores. Mismo criterio que admite_matches: `socio_unico` afirma lo mismo con ' +
          'más resolución.',
      },
      padron_completo_hasta: {
        nivel: 'N1',
        exportable: true,
        nota: 'ESPEJO ESTRUCTURAL del alcance de la manifestación citada — NO ES DATO: es lo que vuelve ' +
          'fila-local el invariante de frescura. Mismo idiom que tenant_node.parent_path. Nombre distinto del ' +
          'de la madre a propósito, para que se lea como espejo y no como copia.',
      },
      resuelto_a_fecha: {
        nivel: 'N2',
        exportable: true,
        nota: 'La fecha con la que se evaluó la vigencia de los socios: es una fecha de una transacción del ' +
          'cliente, mismo nivel que movimiento_bancario_crudo.fecha. ⚠️ No es una denormalización de esa ' +
          'columna: es el PARÁMETRO de la corrida, y la diferencia se vuelve visible el día que alguien lea ' +
          'fecha_valor en vez de fecha (ver el comment on column de 0021).',
      },
      created_at: MARCA_TIEMPO,
    },
  },

  /**
   * Satélite 0..N de `reconocimiento_contrapartida` (migración 0021): los socios contra los que
   * matchearon los candidatos de contraparte, con la vía. Nunca la denominación ni el documento.
   */
  reconocimiento_contrapartida_match: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      contrapartida_id: UUID_INTERNO,
      admite_matches: {
        nivel: 'N2',
        exportable: true,
        nota: 'Generada CONSTANTE. Mismo nivel que la del padre: el registro clasifica por nombre, y declararla ' +
          'N1 acá sería una incoherencia sin beneficio.',
      },
      regimen_matches: {
        nivel: 'N2',
        exportable: true,
        nota: 'Escribible pero infalsificable (FK). Mismo nivel que la del padre, por el mismo motivo.',
      },
      socio_id: {
        nivel: 'N2',
        exportable: true,
        nota: '🔴 SEUDÓNIMO ESTABLE DE UNA PERSONA HUMANA ligada a este cliente: opaco pero ENLAZABLE, la misma ' +
          'propiedad que pone a identificador_hmac en N2. Se distingue de movimiento_id (N1), que identifica una ' +
          'transacción y no a alguien: agregado por líneas de log daría el perfil de un socio real desde un ' +
          'almacén sin RLS. N2 y NO N2-R: con N2-R esta tabla entraría sola en tablasQueExigenRolEnLectura() y ' +
          'la cola de revisión se volvería inusable.',
      },
      match_clase: {
        nivel: 'N1',
        exportable: true,
        nota: 'La FORMA del identificador que matcheó, no su valor — precedente literal ' +
          'movimiento_contraparte_identificador.clase. `match_clase` y no `clase`: ver resolucion_estado.',
      },
      created_at: MARCA_TIEMPO,
    },
  },

  // ---------------------------------------------------------------------------
  // `cotizacion_bna` (`0022_cotizacion_bna.sql`) — caché de cotización BNA. Ver
  // `docs/diseno/12-cotizacion-bna-plan.md`.
  // ---------------------------------------------------------------------------

  cotizacion_bna: {
    columnaTenant: 'ninguna',
    motivoSinTenant:
      'Catálogo N0: la cotización oficial del BNA es idéntica para todos los clientes, sin dato de ' +
      'ningún cliente. Se escribe por conJob(\'cargar_cotizaciones\'), nunca por la aplicación en ' +
      'nombre de un cliente.',
    campos: {
      moneda: { nivel: 'N0', exportable: true },
      fecha: { nivel: 'N0', exportable: true },
      compra: { nivel: 'N0', exportable: true },
      venta: { nivel: 'N0', exportable: true },
      fuente: { nivel: 'N0', exportable: true },
      created_at: MARCA_TIEMPO,
    },
  },

  // ---------------------------------------------------------------------------
  // Capa D del cierre mensual (`0027_cierre_mensual.sql`). Once tablas, todas vacías. Convocatoria
  // completa: `24`/`25`/`26-migracion-cierre-mensual.md`. Columnas donde ninguna de las tres
  // convocatorias se pronunció explícito quedan clasificadas por el default de CLAUDE.md ("N2 si hay
  // duda, nunca sin clasificar") aplicando el mismo criterio que sí usaron los dictámenes reales: N1
  // para vocabulario de proceso e identidad declarada, N2 cuando la columna revela un hecho real de
  // ESE cliente (posición financiera, puntualidad contable, relación societaria).
  // ---------------------------------------------------------------------------

  cuenta: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      creada_en: MARCA_TIEMPO,
    },
  },

  cuenta_atributo: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      cuenta_id: UUID_INTERNO,
      cuenta_padre_id: UUID_INTERNO,
      codigo: { nivel: 'N1', exportable: true, nota: 'Código del plan de cuentas del cliente, vocabulario propio — no identifica a nadie por sí solo.' },
      denominacion: {
        nivel: 'N2',
        exportable: true,
        nota: 'Mismo criterio que padron_socio.denominacion: se clasifica por el peor caso, porque puede ' +
          'llevar el nombre de un socio (D-16). El check de dígitos protege NÚMEROS, nunca nombres — la ' +
          'defensa real es padron_socio_id, no este campo.',
      },
      nivel: { nivel: 'N1', exportable: true, nota: 'Profundidad en el árbol del plan de cuentas. Estructural.' },
      rol_funcional: {
        nivel: 'N2',
        exportable: true,
        nota: 'NO hereda N1 de "vocabulario cerrado": afirma un hecho real sobre la relación societaria de ' +
          'ESTE cliente (que existe una cuenta particular/aporte/retiro de un socio) — mismo argumento que ' +
          'ya clasificó reconocimiento_contrapartida.admite_matches en N2 pese a ser booleano cerrado ' +
          '(seguridad-datos-financieros, convocatoria de 0027).',
      },
      padron_socio_id: {
        nivel: 'N2',
        exportable: true,
        nota: 'Seudónimo estable de un socio — mismo tier que reconocimiento_contrapartida_match.socio_id. ' +
          'D-25, segunda convocatoria. Referencia a la SERIE de alta vigente al momento de clasificar, no ' +
          'una identidad eterna de la persona (dba-data, convocatoria de D-25).',
      },
      activa: { nivel: 'N1', exportable: true },
      vigente_desde: {
        nivel: 'N2',
        exportable: true,
        nota: 'Mismo criterio que padron_socio.vigente_desde: se clasifica por el peor caso (cuando ' +
          'rol_funcional liga a un socio puntual, la vigencia es de una relación societaria, no de un ' +
          'identificador técnico).',
      },
      vigente_hasta: { nivel: 'N2', exportable: true },
      respaldo: { nivel: 'N2', exportable: true, nota: 'Prosa libre escrita por una persona — mismo criterio que cierre_transicion.motivo.' },
      creada_en: MARCA_TIEMPO,
    },
  },

  documento_ingerido: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      superseded_by_id: UUID_INTERNO,
      tipo_documento: { nivel: 'N1', exportable: true, nota: 'Vocabulario cerrado de catálogo, mismo tier que lote_ingesta.banco_codigo.' },
      banco_codigo: { nivel: 'N1', exportable: true },
      periodo_desde: {
        nivel: 'N2',
        exportable: true,
        nota: 'El borde revela cuándo se abrió/cerró la relación con esta fuente para ESTE cliente — mismo ' +
          'nivel que cuenta_bancaria.abierta_desde/cerrada_en (ratificado HANDOFF 47, extendido acá por ' +
          'dba-data en la convocatoria de 0027).',
      },
      periodo_hasta: { nivel: 'N2', exportable: true },
      cobertura: { nivel: 'N1', exportable: true, nota: 'Vocabulario de proceso: qué tan completo declara ser el documento, no un hecho del cliente.' },
      objeto_almacenamiento: {
        nivel: 'N1',
        exportable: false,
        nota: 'Clave de storage, no contenido — mismo criterio que lote_ingesta.archivo_clave. NUNCA lleva ' +
          'el hash del contenido (volvería al storage un oráculo de "¿tenés este archivo?").',
      },
      ingerido_en: MARCA_TIEMPO,
      creado_en: MARCA_TIEMPO,
    },
  },

  cierre_cliente_periodo: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      cierre_anterior_id: UUID_INTERNO,
      tipo_periodo: { nivel: 'N1', exportable: true },
      periodo_desde: { nivel: 'N2', exportable: true, nota: 'Mismo criterio que documento_ingerido.periodo_desde.' },
      periodo_hasta: { nivel: 'N2', exportable: true },
      cierre_estado: {
        nivel: 'N2',
        exportable: true,
        nota: 'D-19 (segunda convocatoria): agregado de TODO un período de un cliente, no metadato de ' +
          'proceso — revela su puntualidad contable real, a diferencia de lote_ingesta.estado (pipeline ' +
          'técnico de un archivo). Renombrado de `estado` a secas: el registro clasifica por nombre ' +
          'GLOBALMENTE y hubiera tapado la N1 de lote_ingesta.estado.',
      },
      confirmado_en: { nivel: 'N2', exportable: true, nota: 'Mismo tier que cierre_estado: es CUÁNDO se alcanzó ese hecho agregado, no un timestamp técnico.' },
      confirmado_por: {
        nivel: 'N1',
        exportable: true,
        nota: 'Identidad declarada ≠ identidad autenticada (mismo patrón manifestado_por, D-21).',
      },
      creado_en: MARCA_TIEMPO,
    },
  },

  cierre_transicion: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      cierre_id: UUID_INTERNO,
      estado_desde: { nivel: 'N2', exportable: true, nota: 'Mismo tier que cierre_estado: es el mismo dato, en su historial.' },
      estado_hasta: { nivel: 'N2', exportable: true },
      motivo: { nivel: 'N2', exportable: true, nota: 'Prosa libre escrita por una persona — puede mencionar al cliente, mismo criterio que registro_auditoria.motivo.' },
      hecho_via: {
        nivel: 'N1',
        exportable: true,
        nota: 'manual|automatico — vocabulario de proceso sobre el ORIGEN de la transición, no sobre el ' +
          'cliente (seguridad-datos-financieros + arquitecto-software, convocatoria de 0027: hecho_por ' +
          'nunca nulo, ni para transiciones automáticas — "el nulo no es información, es camuflaje").',
      },
      hecho_por: { nivel: 'N1', exportable: true, nota: 'Identidad declarada ≠ autenticada.' },
      ocurrido_en: { nivel: 'N2', exportable: true, nota: 'Mismo tier que estado_desde/estado_hasta.' },
    },
  },

  expectativa_fuente_cliente: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      cuenta_bancaria_id: UUID_INTERNO,
      superseded_by_id: UUID_INTERNO,
      tipo_documento: { nivel: 'N1', exportable: true },
      banco_codigo: { nivel: 'N1', exportable: true },
      periodicidad: { nivel: 'N1', exportable: true },
      origen: { nivel: 'N1', exportable: true, nota: 'declarado|inferido_* — vocabulario de proceso sobre cómo se generó la fila, no del cliente.' },
      evidencia: { nivel: 'N2', exportable: false, nota: 'Qué disparó la inferencia — puede referenciar movimientos/literales reales del cliente.' },
      confirmada: {
        nivel: 'N2',
        exportable: true,
        nota: 'Que esta fuente exista y esté ratificada revela un hecho financiero real del cliente (p. ej. ' +
          '"tiene FCI") — no es un booleano de proceso.',
      },
      vigencia_desde: { nivel: 'N2', exportable: true },
      vigencia_hasta: { nivel: 'N2', exportable: true },
      creado_en: MARCA_TIEMPO,
    },
  },

  fuente_cierre: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      cierre_id: UUID_INTERNO,
      documento_ingerido_id: UUID_INTERNO,
      expectativa_id: UUID_INTERNO,
      cuenta_bancaria_id: UUID_INTERNO,
      superseded_by_id: UUID_INTERNO,
      estado_cuadratura: {
        nivel: 'N2',
        exportable: false,
        nota: 'Mismo criterio que lote_ingesta_cuenta.verificacion_detalle: ninguna diferencia lleva un ' +
          'VALOR, solo códigos y referencias de fila — pero es información de cuadratura real de ESE ' +
          'cliente, no un booleano de proceso.',
      },
      creado_en: MARCA_TIEMPO,
    },
  },

  pendiente_cierre: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      cierre_id: UUID_INTERNO,
      fuente_cierre_id: UUID_INTERNO,
      expectativa_id: UUID_INTERNO,
      resolucion_id: UUID_INTERNO,
      superseded_by_id: UUID_INTERNO,
      referencia_origen: { nivel: 'N2', exportable: false, nota: 'Digest de un renglón de fuente, mismo criterio que reconocimiento_movimiento.entrada_digest.' },
      motivo_codigo: {
        nivel: 'N1',
        exportable: true,
        nota: 'Vocabulario cerrado, mismo tier que reconocimiento_movimiento.que_decide. `_codigo` y NO ' +
          '`motivo` a secas: ese nombre ya está clasificado N2 para prosa libre (registro_auditoria.motivo) ' +
          '— heredarlo taparía esa clasificación (seguridad-datos-financieros, convocatoria de 0027, mismo ' +
          'mecanismo que ya forzó `cierre_estado`/`asiento_estado`/`pendiente_estado`).',
      },
      pendiente_estado: {
        nivel: 'N1',
        exportable: true,
        nota: 'D-19: marcador de workflow sobre UN ítem puntual de la cola, no un juicio agregado sobre el ' +
          'cliente (a diferencia de cierre_estado).',
      },
      resuelto_por: { nivel: 'N1', exportable: true, nota: 'Identidad declarada ≠ autenticada.' },
      resuelto_en: { nivel: 'N1', exportable: true, nota: 'Mismo tier que pendiente_estado.' },
      creado_en: MARCA_TIEMPO,
    },
  },

  pendiente_dispensa: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      pendiente_cierre_id: UUID_INTERNO,
      motivo: { nivel: 'N2', exportable: true, nota: 'Prosa libre escrita por una persona — mismo criterio que cierre_transicion.motivo.' },
      dispensado_por: { nivel: 'N1', exportable: true, nota: 'Identidad declarada ≠ autenticada.' },
      dispensado_en: { nivel: 'N1', exportable: true, nota: 'Mismo tier que pendiente_estado (D-24 lo agrega como un valor de esa columna).' },
    },
  },

  asiento_propuesto: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      cierre_id: UUID_INTERNO,
      superseded_by_id: UUID_INTERNO,
      tipo: { nivel: 'N1', exportable: true, nota: 'Vocabulario de proceso: qué clase de asiento es, no su contenido.' },
      fecha_imputacion: { nivel: 'N2', exportable: true, nota: 'La fecha contable real de un hecho económico de ESTE cliente.' },
      asiento_estado: {
        nivel: 'N1',
        exportable: true,
        nota: 'D-19: marcador de workflow puntual (propuesto/confirmado/superseded), mismo tier que ' +
          'reconocimiento_movimiento.clase/.es_propuesta.',
      },
      creado_en: MARCA_TIEMPO,
    },
  },

  asiento_propuesto_renglon: {
    columnaTenant: 'cliente_id',
    campos: {
      id: UUID_INTERNO,
      cliente_id: UUID_INTERNO,
      asiento_id: UUID_INTERNO,
      fuente_cierre_id: UUID_INTERNO,
      padron_manifestacion_id: UUID_INTERNO,
      orden: { nivel: 'N1', exportable: true },
      cuenta_id: UUID_INTERNO,
      cuenta_ref: {
        nivel: 'N2',
        exportable: true,
        nota: 'Cita congelada {codigo, denominacion, rol_funcional} del plan de cuentas — mismo nivel que ' +
          'cuenta_atributo.denominacion (D-15/D-16).',
      },
      debe: { nivel: 'N2', exportable: true, nota: 'Importe de ESTE cliente, mismo tier que movimiento_bancario_crudo.importe.' },
      haber: { nivel: 'N2', exportable: true },
      fecha_imputacion: { nivel: 'N2', exportable: true },
      referencia_origen: { nivel: 'N2', exportable: false, nota: 'Mismo criterio que pendiente_cierre.referencia_origen.' },
      verificacion_heredada: {
        nivel: 'N2',
        exportable: false,
        nota: 'D-20: N2 por defecto hasta que el CHECK de allowlist+vocabulario cerrado (0027) esté además ' +
          'reforzado por Zod en el límite de escritura — el riesgo concreto es que se cuele ' +
          'ConfianzaDeCampo.valorLeido de una liquidación OCR.',
      },
      valuacion_ref: {
        nivel: 'N2',
        exportable: true,
        nota: 'Cotización usada o capas de FCI consumidas — plata del propio cliente, mismo tier que valuacion en general (D-7/D-20).',
      },
      creado_en: MARCA_TIEMPO,
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
  /**
   * 🔴 Agregada ANTES de que exista el tipo que la produce (plan 15, OCR de liquidaciones — commit 2
   * del plan 14, retomado 2026-08-19). `ConfianzaDeCampo.valorLeido` (`liquidaciones/captura.ts`) va a
   * traer el texto que el OCR reconoció de una liquidación de tarjeta real: facturación de un comercio
   * identificable. El documento real va a estar abierto en la sesión de desarrollo del adapter — es
   * exactamente el momento en que un `logger.info(...)` de depuración saca ese dato a una terminal o a
   * un log de CI. Cerrar el hueco antes de que el tipo exista es la condición bloqueante del paso 0 del
   * plan 15: R27 tiene que rechazar `{ valorLeido: … }` en compilación desde el primer commit que lo
   * use, no desde que alguien se acuerde de agregarlo.
   */
  'valor_leido',
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
