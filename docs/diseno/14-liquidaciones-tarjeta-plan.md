# 14 — Plan de diseño: módulo de liquidaciones de tarjeta (crédito/débito)

> 🔴 **PLAN APROBADO POR JP — NO IMPLEMENTADO.** Ningún archivo de código de este plan existe
> todavía en el filesystem. No hay migración, no hay paquete ni subárbol nuevo, no se tocó el
> piloto. Este documento es el plan formal de CLAUDE.md §3.2, con los tres dictámenes de agentes
> que lo sostienen (`contador-dominio`, `motor-conciliacion-contable`, `arquitecto-software`) — el
> estado exacto para retomar sin perder nada, incluso sin memoria de la sesión que lo escribió.

## Contexto

Laura (contadora del estudio) resolvió con precisión el circuito de tarjeta **del lado pagador**
(tarjeta corporativa), pero del lado **cobrador** el sistema hoy tiene un hueco medido: la regla 11
del material de la contadora — acreditación de tarjeta — llega al extracto bancario **neta** de
arancel, IVA y retenciones, y esos componentes no están en el extracto en ninguna forma. Están en
la **liquidación del adquirente**, un documento que hoy el sistema no sabe leer. Sin él, la regla
11 queda mal para siempre (`docs/diseno/01-modulo-1-ingesta-bancaria.md` §11), y el catálogo
canónico ya tiene 78+ movimientos de `acreditacion_tarjeta` esperando exactamente este dato
(`packages/contabilidad/src/nucleo/catalogo.ts`, `queDecide:
'completar_con_liquidacion_del_adquirente'`).

Esta sesión analizó tres liquidaciones reales de un cliente del estudio (Visa débito, Visa
crédito, Cabal débito — mismo banco pagador, mismo mes), verificadas aritméticamente palabra por
palabra, y convocó a `contador-dominio`, `motor-conciliacion-contable` y `arquitecto-software` para
diseñar el módulo que las procesa. **Los tres dictámenes están completos y son la base de este
plan.** Los montos, el nombre del cliente y sus datos de cuenta **no aparecen en este documento** —
son datos financieros de un tercero (regla dura CLAUDE.md §1.4); lo que sigue usa porcentajes (del
formato del adquirente, no del cliente), estructura y conteos.

### Lo medido en los tres documentos, sin datos del cliente

- **Visa débito**: arancel 1,0% de ventas (exacto en 4 bloques verificados) + IVA 21% sobre el
  arancel + retención IIBB SIRTAC + percepción IVA RG 2408. Trae resumen consolidado mensual
  (checksum del emisor). 21 liquidaciones en el mes.
- **Visa crédito**: mezcla sub-tipos de venta dentro de la misma liquidación — contado (descuento
  con IVA 21%) y cuotas (interés de financiación con IVA 10,5%) — cada uno con su propia base y su
  propia alícuota de IVA. El arancel (1,0%, verificado) se calcula sobre el total de cupones sin
  distinguir sub-tipo. Retención IIBB SIRTAC = 3,5% de ventas totales (desambiguado acá: es % de
  ventas, no de arancel). Percepción IVA con DOS tasas (1,50%/3,00%) en el mismo bloque, sin
  fórmula derivable contra ninguna base probada.
- **Cabal débito**: misma descomposición que débito Visa (arancel 1%, IVA 21% s/arancel, retención
  IIBB 3,5% s/ventas — **tercer proveedor que confirma el patrón**), pero SIN percepción IVA en
  ningún bloque y SIN resumen consolidado mensual — cada liquidación es un bloque independiente,
  sin checksum del emisor.
- Los tres documentos comparten conceptos pero **ninguno tiene el mismo conjunto exacto** — el
  modelo de datos no puede ser columnas fijas por concepto.

---

## 1. Qué cambia y qué no

### Cambia (cuando se implemente — nada de esto existe todavía)

- **Subárbol `packages/ingesta/src/liquidaciones/`, NO un paquete nuevo.** Decisión de JP, sobre la
  recomendación de `arquitecto-software`: la analogía con `packages/cotizaciones` es falsa —
  aquello es el cuarto punto de contacto con un **proveedor externo de red** (ADR-0000 §3.5); una
  liquidación de adquirente es **otro documento que el operador sube**, exactamente el dominio de
  `packages/ingesta`. El reuso es real y medido: extracción y geometría de pdf.js (`texto-pdf.ts`),
  parseo de importes AR (`parseo-ar.ts`), lectura por etiqueta (`valorPorEtiqueta` — nunca por
  patrón, la lección de los 113 CUIT falsos positivos), hash de fila e idempotencia, el pipeline de
  controles del CLI. Un paquete nuevo forzaría o bien duplicar esa infraestructura o bien una arista
  nueva `liquidaciones-tarjeta → ingesta` que las reglas de dependencia hoy no vigilan.
  Estructura: `packages/ingesta/src/liquidaciones/{contrato,registro,esquema}.ts`, espejo de
  `src/adaptadores/`. El contrato bancario existente (`Adaptador`, `EntradaDeAdaptador`,
  `SalidaDeAdaptador` de `registro.ts`) **no sirve tal cual** — tres bloqueos duros: (a)
  `lote_ingesta.banco_codigo` es `not null references banco(codigo)`, y Visa/Cabal/First Data no
  son bancos; (b) la salida es `CuentaConMovimientos[]` + `ConsolidadoPorMoneda[]`, sin forma de
  liquidación; (c) compartir el registro con los adapters bancarios amplía la superficie del caso
  `ambiguo` (ya hay un precedente real: un PDF de Credicoop byte-idéntico a uno de ICBC) sin ganar
  nada. Lo que sí se reusa tal cual: las tres reglas de `contrato.ts` (no autocertificar / declarar
  capacidades / no descartar en silencio), `ErrorDeAdaptador`, el modelo de registro con sus tres
  respuestas.
  Dos reglas nuevas en `packages/data/tests/reglas-de-codigo.test.ts` (mismo mecanismo que ya
  prohíbe a `packages/data` importar `cotizaciones`): ningún adapter de `liquidaciones/` importa un
  adapter bancario ni viceversa; y un guard de cobertura (`FUENTES` tiene que VER el directorio
  nuevo) para que un barrido que no alcanza la carpeta no pase en verde por vacío.

- **Identificación del documento: declarar + detectar + comparar** — no "manual a secas". El patrón
  real del Módulo 1 (verificado, no supuesto) no es que el operador declare y el sistema confíe: es
  que el operador declara (`--banco`, obligatorio, sin default) y el adapter **detecta por
  contenido** (`resolverAdaptador`) y **rechaza si no coincide**, sin decir cuál detectó (evita
  filtrar información de otro cliente si el operador se equivocó de carpeta). Este módulo reusa el
  patrón completo: el operador declara `--formato` (procesadora + tipo de tarjeta), el adapter
  `reconoce()` el documento y verifica — la detección nunca ELIGE el formato, solo VETA una
  declaración incorrecta. Es la misma garantía que ya tiene el Módulo 1, no una excepción a la
  restricción de "sin auto-detección".

- **Catálogo de plataforma N0 `formato_liquidacion`**, gemelo estructural de `banco` — **nunca
  filas en `banco`** (contaminaría un catálogo cuyas capacidades declaran cosas de extractos
  bancarios — saldo por fila, totales — que no significan nada para una liquidación, y
  `banco.codigo` recibe FKs que asumen que la fila es un banco real). Fila = el FORMATO
  (`visa_debito`, `visa_credito`, `cabal_debito`), `unique (procesadora, tipo_tarjeta)`,
  `capacidades jsonb` informativo (fuente de verdad en TS, mismo contrato que `banco`; primera
  capacidad real medida: `traeTotalDelEmisor` — verdadero para Visa, falso para Cabal). Sostiene la
  misma invariante que hizo funcionar el Módulo 1: una fila del catálogo = un adapter = lo que el
  operador declara.

- **Lote propio `lote_liquidacion`** (no reutiliza `lote_ingesta`): los siete renglones obligatorios
  de ADR-0001 §5 (la liquidación es dato N2 del cliente — CUIT, ventas, actividad comercial),
  idempotencia por `(cliente_id, archivo_hash)`, FK a `formato_liquidacion`.

- **Catálogo de tipos de concepto de liquidación = unión cerrada en TypeScript**, viviendo con el
  parser (`liquidaciones/esquema.ts`), **no en `packages/contabilidad`** — son paquetes hermanos que
  no se importan entre sí (R-B). Criterio código/tabla que queda fijado para este y futuros
  catálogos: **tabla** es lo que recibe FK desde filas de dominio o cambia sin deploy (`banco`,
  `cotizacion_bna`); **código** es lo que gobierna comportamiento determinístico y cuya alta exige
  código nuevo de todos modos (`CONCEPTOS_CANONICOS`, `ORIGENES_LOTE`, y este catálogo). Al
  persistir un renglón, el concepto va como `text` + `check constraint` que espeja la unión (mismo
  patrón que `TIPOS_CUENTA`/`catalogo.test.ts`), con un espejo R-H si los nombres tienen que
  coincidir con el catálogo contable.
  Conceptos medidos en los tres documentos (procedencia = `corpus_medido`, mismo shape que
  `porLiteral` del catálogo canónico): `arancel`, `iva_21_sobre_arancel`,
  `retencion_iibb_sirtac`, `percepcion_iva_rg2408` (con sus dos tasas como **atributo del renglón**,
  no dos conceptos separados — la fórmula queda pendiente, no la captura), `descuento_contado_adquirente`
  (IVA 21%), `interes_financiacion_cuotas` (IVA 10,5%). Los sub-tipos de venta de Visa crédito
  (contado/cuotas) se modelan como renglones con concepto propio dentro de la misma liquidación, no
  como columnas fijas — exactamente la restricción original de JP.

- **Cada renglón persiste base + alícuota publicada + monto, CRUDOS del documento** — nunca un
  monto solo, y nunca un monto reconstruido desde un porcentaje cableado en código. Es la condición
  no negociable que separa "el sistema lee lo que el agente retuvo" de "el sistema calcula la
  retención" — este módulo hace lo primero.

- **Verificación en tres ejes ortogonales**, cada uno con el mismo tri-estado que ya usa el Módulo 1
  (`cuadra | no_cuadra | no_verificable`, con motivo de un roster cerrado — nunca `no_verificable`
  sin motivo, y ese roster no puede crecer sin que crezca el conteo de motivos declarados):
  1. **Aritmética por liquidación**: ventas − arancel − IVA − retenciones ± percepción = neto, al
     centavo. Cabal SÍ es verificable en este eje (cada liquidación cierra sola).
  2. **Checksum del emisor**: Σ liquidaciones == total consolidado publicado. Cabal:
     `no_verificable, emisor_no_publica_total` — no es "sin verificación posible" en general, es
     este eje específico el que no aplica.
  3. **Cruce contra el extracto bancario**: multiset con buckets — `matcheadas`,
     `liquidacion_sin_movimiento` (el emisor dice haber pagado y el banco no muestra — la alarma
     más valiosa), `movimiento_sin_liquidacion` (una acreditación cuyo documento falta — es el
     estado actual, ahora nombrado, de los 78+ `ACREDITAMIENTO`/`acreditacion_tarjeta_*` que hoy
     están indecidibles).
     Con esto, Cabal (sin checksum propio) usa el **cruce contra extracto** como su verificación
     mensual real, tal como pedía la restricción original de JP — pero declarado como eje 3, nunca
     disfrazado de eje 2.

- **Matching = escalera de vías** (no una clave única):
  1. `por_numero_de_liquidacion` — si el extracto publica el número en la glosa (capacidad
     declarada por banco, `traeNumeroDeLiquidacionEnGlosa`, nunca inferida).
  2. `por_fecha_y_neto` — universo acotado a (cliente, cuenta, procesadora+marca+tipo), ventana de
     días hábiles declarada por formato; dos o más candidatos → `ambiguo`, listados, nunca el más
     cercano.
  3. `por_agregado_del_dia` — solo si se mide que el banco consolida (predicción falsable, §3);
     prohibido subset-sum.
  Tolerancia de monto: **cero** (una diferencia es un hecho — contracargo, ajuste — no ruido).
  Cruce por liquidación individual; el agregado mensual es **diagnóstico, nunca gate** (falla
  estructuralmente en cualquier mes con corte de período, y puede cuadrar por compensación). Corte
  de período: dos estados nombrados, `acreditada_en_periodo_siguiente` y `pendiente_de_extracto`
  ("todavía no puede haber llegado" ≠ "no llegó").

- **Conexión con el catálogo canónico de `packages/contabilidad`**: NO es una vía nueva en
  `VIAS_EVIDENCIA` (las vías responden CÓMO se reconoció el concepto; acá lo que faltaba eran los
  componentes del asiento, no el reconocimiento — `ACREDITAMIENTO` ya está confirmado por Laura). Es
  una dimensión nueva de la propuesta: `fuenteDeComponentes: 'liquidacion_adquirente' |
  'no_disponible'`. El idiom es exactamente `PadronConsultado`: tipo `LiquidacionConciliada`
  (marca de tipo con `unique symbol`, construible en un solo lugar), el núcleo sigue puro y síncrono
  (R-J intacto — ya hay una regla que lo verifica, agregada preventivamente en el plan de cotización
  BNA). Decisiones humanas ya registradas no se recalculan solas al cargar liquidaciones viejas.
  **Nunca se estima el bruto** cuando la liquidación falta — sigue vigente la resolución ya escrita
  en `04-imputacion-contable.md` §5.1: se propone el neto con `estado: incompleto`.

- **Asiento tipo** (posición de `contador-dominio`, fundada, no normativa donde la norma no está
  cargada): Debe = Banco (neto) + arancel (gasto) + descuento contado adquirente (cuenta propia,
  aunque el banco lo llame "financiación" — es el precio de cobrar antes, no interés real) +
  interés de financiación en cuotas (resultado financiero, cuenta propia, IVA 10,5%) + IVA crédito
  fiscal 21% + IVA crédito fiscal 10,5% + retenciones IIBB sufridas **por jurisdicción** (si el
  documento no la publica, el renglón queda `jurisdiccion: no_publicada` — nunca se deduce) +
  percepciones IVA sufridas (cuenta **separada** del crédito fiscal — mezclarlas produce "crédito
  inflado y percepción perdida"). Haber = la cuenta a cobrar, por el bruto presentado. Si la suma
  de renglones no reproduce el bruto del documento, el asiento no se propone completo.
  El caveat impreso en los documentos reales ("no válido para el cómputo de retenciones y/o
  percepciones") se modela con dos estados separados: `registrado` (el asiento entra con la
  liquidación como evidencia — el hecho económico ocurrió) ≠ `computable_confirmado` (el cómputo
  fiscal formal exige el comprobante habilitante, hoy sin fuente cargada).

- **Anti-fuga, sin excepción** (posición categórica de `motor-conciliacion-contable`): el catálogo
  N0 lleva **estructura** (qué componentes puede tener cada formato y sobre qué base se calcula
  cada uno) — **cero valores, cero porcentajes**. El arancel es un término negociado por comercio; la
  alícuota SIRTAC depende de un padrón por contribuyente. Un % en una tabla compartida es H-6 (un
  dato de la relación comercial de un cliente filtrado a otro), y la agregación no desclasifica. Los
  % **esperados** (si se llegan a modelar) van en una tabla **N2 por cliente, con vigencia**,
  sembrada de las propias liquidaciones de ESE cliente y confirmada por su contador — nunca
  promovida entre clientes. El patrón técnico ya existe y está probado: `padron_socio` (vigencia
  semiabierta `[desde, hasta)`, check `>` estricto, índice único parcial `where vigente_hasta is
  null`, sin policy de `DELETE`, `grant update` acotado a las columnas corregibles). El % **efectivo**
  siempre se calcula de cada liquidación real; un esperado, si existiera, solo produce una señal de
  desvío visible — nunca un bloqueo ni un ajuste automático.

- **Verificador nuevo del residuo**: el saldo de la cuenta puente `TARJETAS A LIQUIDAR` (ya diseñada
  en `04-imputacion-contable.md` §7.1) debería explicarse exactamente por la suma de
  `liquidacion_sin_movimiento` + `movimiento_sin_liquidacion` abiertas. Si no coincide, hay un match
  mal hecho — verificación sin ninguna etiqueta humana, análoga al cruce del anexo del banco (05
  §8.5).

### No cambia — alcance explícito, a propósito

- **Nada se implementa en esta tarea.** Este documento es research + diseño; el código, el esquema y
  el paquete/subárbol quedan para una sesión posterior, con su propio modo plan de CLAUDE.md §3.2.
- **`packages/contabilidad/src/nucleo` sigue síncrono, sin red, sin cambios.** La liquidación entra
  siempre como argumento ya resuelto.
- **SIRTAC no se modela como entidad propia todavía.** Con tres documentos de un solo agente de
  retención medidos, ni siquiera se conocen las dimensiones reales de la entidad (¿el padrón asigna
  alícuota por CUIT? es pregunta de `fiscal-ingresos-brutos-convenio-multilateral`, sin fuente
  cargada hoy). Lo no negociable —persistir base/alícuota/monto crudos por renglón— ya está en
  "Cambia": eso hace que modelarla después sea barato (se deriva de filas ya guardadas), y no
  modelarla ahora no pierde nada. El disparador para modelarla es la llegada de Vía B (el estudio
  calcula), no una fecha.
- **La dimensión Vía A (cliente entrega ya procesado) / Vía B (el estudio calcula) no se diseña
  acá.** Es un atributo del cliente, con vigencia temporal, del dominio de
  `plan-cuentas-multicliente` (pendiente de otra conversación). El único compromiso de este módulo:
  el parser es **vía-agnóstico por construcción** — ningún archivo de `liquidaciones/` tiene rama,
  columna ni enum de vía. Cuando Vía A/B exista, entra al motor como argumento resuelto, igual que
  la liquidación misma.
- **La percepción de IVA con dos tasas (1,50%/3,00%) sigue sin fórmula.** Se registra el importe tal
  como el documento lo publica (dato, no cálculo); la fórmula queda pendiente de confirmar con
  Laura y con `fiscal-nacional-iva-ganancias` — no se resuelve en este plan ni se adivina.
- **Sin ADR nuevo.** No hay ninguna decisión estructural que no reuse un patrón ya escrito
  (adapter-por-formato, catálogo N0, plantilla de tenancy, núcleo síncrono). El registro correcto es
  este plan + los tests de arquitectura nuevos. Una adenda a un ADR existente solo si, al
  implementar, una migración vuelve falsa una afirmación ya escrita (mismo caso que R19 con
  `cotizacion_bna`).
- **Las cinco discrepancias entre documentación y código detectadas en esta sesión** (docs 04/05/08
  todavía listan como abiertas preguntas que el catálogo ya resolvió; 05 §8.5 dice que la tabla de
  anexos "no existe" y existe desde `0008`; 04 §6.1 afirma que un débito bajo `acreditacion_tarjeta`
  "no existe" y el corpus medido tiene tres) **no se corrigen en este plan** — quedan para un commit
  de documentación aparte, sin relación de precedencia con la implementación de este módulo.
- **Los 76 movimientos de Macro (`PAGO<n>-LIQ COMER <procesadora>`) siguen incapturables** por la
  interacción entre INV-13 (máscara de dígitos) e INV-14 (prefijo literal exacto) — es un problema
  del léxico del Módulo 2 sobre Macro, no de este módulo. Este plan lo señala como dependencia, no
  lo resuelve.
- **El join fuerte por número de comercio/terminal no se da por existente.** `TIPOS_REFERENCIA` ya
  declara los tipos `comercio`/`terminal` en el esquema, pero si la extracción y persistencia
  efectiva ocurre hoy en los tres adaptadores bancarios es una pregunta abierta (marcada 🔴 en
  `05-motor-de-reconocimiento.md` §9) — se mide en el commit 2 de la implementación (§5), no se
  asume acá en ningún sentido.

---

## 2. Qué se mide

- `pnpm typecheck`/`pnpm barrido`/`pnpm verificar` siguen en verde de punta a punta — este plan no
  toca código, así que el número no se mueve (línea de base al escribir este documento: 67 archivos
  / 1529 tests / 0 fallas).
- El barrido de fuga corre contra este documento antes de commitear, igual que se hizo con el
  backlog de extractos PDF/Excel — cero valores del material real (`privado/tarjetas/`) presentes.
- Cuando se implemente (fuera de esta tarea): el barrido de `reglas-de-codigo.test.ts` tiene que dar
  **rojo** antes de agregar la regla de aislamiento del subárbol de `liquidaciones/` (confirma que
  reacciona) y **verde** después — mismo método que el plan 12.

## 3. Predicción falsable

| Si sale... | Significa... |
|---|---|
| Las liquidaciones Visa débito de un mes matchean 1:1 contra los créditos del extracto del mismo período | El banco acredita una liquidación = un movimiento — la escalera de matching queda como está, `por_agregado_del_dia` sigue siendo el último recurso |
| Matchean MENOS movimientos que liquidaciones (el banco consolida varias en un solo crédito) | `por_agregado_del_dia` sube de fallback a vía principal para ese banco/formato — hay que revisar la escalera antes de darla por cerrada |
| El extracto de algún banco (ej. Macro) publica el número de liquidación en la glosa del movimiento | La vía fuerte (`por_numero_de_liquidacion`) existe para ese banco — se declara como capacidad, no se asume |
| La aritmética interna de alguna liquidación real no cierra al centavo contra lo medido | O el parser tiene un bug, o hay un concepto del documento sin catalogar todavía — nunca se tolera como redondeo |
| Aparece un cuarto formato (otra procesadora, u otro banco pagador) con un concepto que ninguno de los tres actuales tiene | El catálogo extensible lo absorbe con un commit nuevo (concepto + evidencia + parser), sin tocar el esquema de columnas — es la prueba de que el diseño cumplió su propósito |
| `referencias[]` con tipo `comercio`/`terminal` NO se está persistiendo hoy en los adaptadores bancarios (a medir en el commit 2 de la implementación) | La vía fuerte de matching no existe todavía para ningún banco — todo el matching inicial degrada a `por_fecha_y_neto`, y capturar esas referencias pasa a ser un insumo previo, no un detalle |

## 4. Qué agentes se convocan

**Ya convocados y con dictamen entregado, en esta sesión** (satisface CLAUDE.md §3.1 de forma
estructural):

- `contador-dominio` — asiento tipo, la posición sobre "Deudores por ventas" vs. cuenta específica,
  el tratamiento del caveat de cómputo fiscal, contado vs. cuotas, SIRTAC, verificación mensual.
  Advierte explícitamente: `knowledge/` sigue siendo esqueleto sin contenido — toda afirmación
  normativa de este plan (RG del caveat, régimen de percepción IVA, SIRTAC, cómputo de crédito
  fiscal, RT de componentes financieros) es **"no tengo esa fuente cargada"**, y así queda marcada.
  **Validar con profesional matriculado** todo lo fiscal de este plan.
- `motor-conciliacion-contable` — la escalera de matching, la corrección al enum de verificación
  (de un eje colapsado a tres ortogonales), cortes de período, la conexión con
  `VIAS_EVIDENCIA`/`fuenteDeComponentes`, la evidencia mínima en la cola de revisión, y el límite
  categórico de anti-fuga sobre el catálogo N0.
- `arquitecto-software` — subárbol vs. paquete nuevo (con la decisión final de JP registrada
  arriba), unión cerrada vs. tabla para el catálogo de conceptos, `formato_liquidacion` como
  catálogo propio, por qué SIRTAC es prematuro, el punto de conexión con Vía A/B, por qué no hace
  falta ADR nuevo, y la secuencia de commits de §5.

**A convocar al implementar** (fuera de esta tarea):

- `dba-data` + `security-engineer` + `seguridad-datos-financieros` — obligatorio, sin excepción,
  para el commit de esquema (§5, paso 3): `formato_liquidacion`, `lote_liquidacion` y los renglones
  de liquidación son tablas nuevas, una de ellas con datos financieros reales de un tercero (ventas,
  retenciones, CUIT del comercio).
- `backend-dev` escribe el código de cada commit; `code-reviewer` revisa antes de cerrar cada uno.
- `fiscal-nacional-iva-ganancias` — la fórmula de la percepción IVA RG 2408 de dos tasas, y la
  computabilidad real del crédito fiscal 21%/10,5%.
- `fiscal-ingresos-brutos-convenio-multilateral` — SIRTAC, si en algún momento se decide modelarla
  como entidad (Vía B).
- `contador-dominio` de nuevo, cuando se escriban las filas del catálogo canónico que conectan
  `LiquidacionConciliada` con `completar_con_liquidacion_del_adquirente`.
- `qa-funcional` / `qa-automation` / `tester` al cerrar cada etapa, como en cualquier trabajo no
  trivial de este repo.

## 5. El paso revertible más chico (secuencia para cuando se implemente)

**Ninguno de estos pasos arranca en esta sesión.** Quedan documentados en orden para que la próxima
sesión sepa por dónde empezar sin tener que re-derivarlo:

1. **Vocabulario + contrato, cero base.** `packages/ingesta/src/liquidaciones/{contrato,registro,
   esquema}.ts`: la unión cerrada de conceptos con procedencia medida de los tres documentos reales,
   el contrato de adapter, el esquema Zod de `LiquidacionProcesada`, y las dos reglas de
   arquitectura nuevas en `reglas-de-codigo.test.ts`. Revertible: borrar un directorio.
2. **Primer adapter (Visa débito) + invariantes + dry-run, sin persistir.** Fixture sintético,
   verificación aritmética de un eje, capacidad `traeTotalDelEmisor` declarada desde el día uno
   (Cabal la ejercita en su propio adapter, más adelante), salida por CLI sin tocar la base. Acá se
   miden los números concretos que el DDL del paso 3 necesita — incluida la predicción falsable de
   `referencias[]` de §3.
3. **La migración**, recién ahora: `formato_liquidacion` (N0) + `lote_liquidacion` + renglones con
   los siete puntos de ADR-0001 §5, check constraint espejo de la unión cerrada, clasificación de
   cada columna, y los barridos actualizados con la misma disciplina de evidencia rojo→verde que ya
   se usó en el plan de cotización BNA. Convoca `dba-data` + `security-engineer` +
   `seguridad-datos-financieros` sin excepción.
4. **Persistencia + comando CLI** (operador declara `--cliente` + `--formato`, mismo contrato de
   guard-antes-de-abrir-el-archivo que ya usa `ingestar.ts`).

Los adapters restantes (Visa crédito con sus sub-tipos, Cabal) son commits chicos posteriores sobre
el patrón ya probado en el paso 2. Las filas del catálogo canónico que conectan la liquidación con
`acreditacion_tarjeta` son un paso **aparte**, con su propia convocatoria a `contador-dominio` +
`motor-conciliacion-contable` — no se mezcla con la construcción del parser.
