# Plan del Módulo 1 — ingesta de extractos bancarios en PDF

**Estado:** plan aprobado por panel, **pendiente de aprobación del titular**. No se escribe una línea más
del adapter hasta que se cierren las condiciones de salida de §10.
**Fecha:** 2026-08-09
**Panel convocado:** `motor-conciliacion-contable`, `contador-dominio`, `plan-cuentas-multicliente`,
`seguridad-datos-financieros`, `tester`, y `fiscal-nacional-iva-ganancias` +
`fiscal-ingresos-brutos-convenio-multilateral` en secuencia. Los seis leyeron el material real.
**Insumos:** `docs/analisis/00-cliente-piloto-laura.md`, los ADR-0000/0001/0002, los tres documentos de
criterio que escribió la contadora, y **los archivos reales de 8 bancos** en `privado/extractos/`.

> **Este documento es el plan para los OCHO bancos, no para Galicia.** Galicia es el primero porque
> junto con Santander cubre el 90% de la cartera del estudio piloto. Todo lo que sigue está escrito para
> que el banco número 3 cueste un archivo nuevo y una línea en un registro, no una reescritura.

---

## 1. Alcance y frontera

**El Módulo 1 responde una sola pregunta: *¿qué dice el documento?*** El Módulo 2 responde *¿qué asiento
corresponde?*. La frontera no es una preferencia de organización: es lo que impide que un error de
criterio contable se entierre dentro de un parser.

| Entra | No entra |
|---|---|
| PDF → tabla de movimientos atomizada, por cuenta | Asignar cuenta contable |
| Verificación aritmética contra el propio extracto | Proponer asiento |
| Export a Excel/CSV de una sola hoja | Detectar transferencias entre cuentas propias |
| Cruce con el Excel del banco del mismo período | Marcar "CUIT de socio" |
| Extracción de identificadores de la contraparte, **sin decidir de quién son** | Reconocer que un débito es del organismo recaudador |
| Captura del bloque de retenciones como **anexo**, sin interpretarlo | Calcular resultado de FCI, reimputar tarjetas |

**La única "clasificación" que entra es estructural, no contable:**
`tipoFila: 'movimiento' | 'saldo_inicial' | 'saldo_final' | 'total' | 'anexo' | 'encabezado' | 'pie'`.
Decir "esta línea es el saldo anterior" es leer el documento, no imputar. Sin eso no hay invariantes.

**Las 14 reglas de clasificación de la contadora NO entran en el Módulo 1** — ninguna. Todas asignan
cuenta y lado, y varias necesitan datos que el extracto no tiene. Van al Módulo 2, con las correcciones
de §3.3.

---

## 2. Hechos medidos sobre el material real

Todo lo que sigue lo midieron los agentes abriendo los archivos, no leyendo el transcript. **Es la base
del plan y reemplaza a cualquier supuesto anterior.**

### 2.1. El roster real: 7 PDFs, no 8

| Banco | Págs. | Chars/pág. | Líneas que arrancan con fecha | Familia de layout | Totales | Saldo por fila | Signo | Año en la fecha | Excel |
|---|---|---|---|---|---|---|---|---|---|
| **Galicia** | 26 | 1.177 | **326** | posicional | sí | sí | sí | sí | `xlsx` ✅ |
| **Santander** | 11 | 1.928 | 162 | posicional | sí | — | — | sí | **texto TSV Latin-1** ⚠️ |
| **Macro** | 45 | 4.914 | 1.346 | **ancho fijo** | por cuenta | por cuenta | — | sí | **BIFF8** ⚠️ |
| **Bancor** | 3 | 3.698 | **1** | ancho fijo | sí | no siempre | **NO publica** | **`dd/mm`** | `xlsx` ✅ |
| **Nación** | 1 | 1.554 | **1** | ancho fijo | sí | — | — | sí | — |
| **ICBC** | 1 | 2.566 | **0** | ancho fijo | — | no siempre | atrás | **`dd-mm`** | — |
| **BBVA** | 6 | **0** | 0 | **imagen** | — | — | — | — | — |
| **Credicoop** | — | — | — | — | — | — | — | — | `.xls` BIFF8 |

**Cuatro hechos que cambian el plan:**

1. **Credicoop no tiene PDF.** El archivo de su carpeta es **byte-idéntico** al de ICBC (mismo md5). Solo
   aportó un `.xls`.
2. **BBVA es imagen pura**: 6 páginas, **cero caracteres extraíbles**. El OCR deja de ser hipotético.
3. **Leer por líneas sirve para 3 de 8 bancos.** Bancor y Nación tienen **una** línea con fecha en todo
   el archivo; ICBC, cero. Para la familia de ancho fijo hace falta **posición**, no línea.
4. **Bancor no publica signo.** Débito vs. crédito **solo** se determina por la cadena de saldos. Ahí la
   aritmética deja de ser la red de seguridad y pasa a ser **la fuente del dato**.

Y un hecho de método: **la ruta y el nombre del archivo no acreditan nada.** Hay un PDF archivado bajo el
banco equivocado, un `.xls` de un banco dentro de la carpeta de otro, y nadie sigue la convención de
nombres. **INV-6 no es una hipótesis de seguridad: es el estado del material de origen.**

### 2.2. Galicia, reconstruido entero

| Medición | Resultado |
|---|---|
| Movimientos | **326** |
| Cadena de saldos `saldo(n−1) + importe(n) = saldo(n)` | **0 eslabones rotos de 325** |
| Σ créditos y Σ débitos vs. la línea `Total` del PDF | **cuadran al centavo, las dos** |
| Saldo inicial implícito vs. el del encabezado | coincide |
| Líneas por movimiento | de 1 a **8** — distribución `{1:64, 3:27, 4:114, 5:9, 6:111, 8:1}` |
| Movimientos que cruzan el corte de página | **1** (real, no hipotético) |
| Páginas físicas vs. declaradas en el pie | **26 vs. 25**, y 1 página vacía |
| Pares `(fecha, importe)` repetidos | **7 grupos, 19 filas** → **no es clave** |
| Claves `(fecha, importe, saldo)` distintas | **326 de 326** → **es clave** |
| Líneas que son solo 11 dígitos (CUIT de contrapartes) | **113**, en 23 páginas |
| Corridas de 7-8 dígitos (documentos de personas humanas) | 7 |
| Tokens que **no** son importes y que `importeACentavos()` acepta | **295** |

**La verificación es exacta, no aproximada.** Eso permite usarla como gate duro, y es lo que convierte
"extraje 326 filas" en prueba.

### 2.3. El Excel: tres tecnologías detrás de la misma palabra

`xlsx` (Galicia, Bancor) lo lee `exceljs`. **BIFF8/OLE2 real** (Macro, Credicoop) **no lo abre**. Y el
`.xls` de Santander **es un archivo de texto**: TSV en Latin-1, con **un bloque por cuenta**, encabezado
repetido y negativos entre paréntesis.

Y el hallazgo contraintuitivo: **el Excel de Galicia de ese mes no perdió nada** (326 filas, sumas
idénticas). Consecuencia de método: un comparador que siempre diga "coinciden" **pasaría** con este par.
Hace falta un test de mutación.

| Medición PDF ↔ Excel | Resultado |
|---|---|
| Filas en la **misma posición** | **2 de 326** → una comparación posicional es inservible |
| Cadena de saldos recorriendo el Excel en su orden | **rota en 217 de 325**, estando el Excel perfecto |
| `Número de Comprobante` vacío | **128 de 326**; 141 valores distintos |

**Y la corrección que importa:** el Excel es **más rico en campos** (trae `Grupo de Conceptos` y
`Concepto` con **código numérico de 6 dígitos**, comprobante, terminal, observaciones del cliente y
leyendas como columnas propias). El PDF es autoritativo en **qué filas existen y en los saldos**.
No es "el PDF trae más": es **PDF = completitud de filas y saldos; Excel = riqueza de campos**.

---

## 3. Lo que el material refutó

### 3.1. De `docs/analisis/00-cliente-piloto-laura.md`

| § | Lo que decía | Lo medido | Acción |
|---|---|---|---|
| 3.2.6 | El número de referencia "es el candidato natural para `referencia_externa` y refuerza el `fila_hash`" | Vacío en 128/326, 141 valores distintos | **No es clave.** Atributo informativo. Corregir |
| 3.3 | "Los PDF que llegan tienen texto real; el OCR baja de prioridad" | **BBVA: 0 caracteres en 6 páginas** | La **conclusión** se mantiene (no construir OCR ahora); la **premisa** es falsa. Corregir y exigir el caso como test de rechazo |
| 3.1 | Cinco bancos | **Nueve** aparecen en el material (ICBC, Credicoop, BBVA además) | Corregir |
| 3.2.1 | El cambio de cuenta se detecta por la denominación | En Macro el encabezado repetido trae **el número de cuenta** | Mejor: el ancla es el número. Corregir |
| 4.3 | "El padrón compartido es N0/N1 y transversal" | Guarda CUIT (N2R) y razón social (N2); un derivado hereda el máximo | **Es N2R con `estudio_id`.** Lo N0 es el nomenclador de actividades. Corregir |
| 7.2.1 | "El PDF trae datos que el Excel no" | El Excel trae **más campos**; el PDF trae más **filas** | Refinar, no borrar |
| cierre | "Nada de lo que está acá permite identificar a un cliente del estudio" | El conjunto es un **cuasi-identificador**: rubro muy preciso + provincia inferible + mayor volumen + entrega en papel | **Generalizar el rubro y separar los pares identificatorios.** La afirmación de cierre es más fuerte que lo que el contenido sostiene |

### 3.2. Del código ya escrito — bugs medidos

| Archivo | Bug | Consecuencia |
|---|---|---|
| `parseo-ar.ts` | **`importeACentavos` acepta cualquier cadena de dígitos** (rama `\|\d+`) | 295 tokens por extracto entran como importe: CUIT, CBU, códigos de columna, números de tarjeta. Cualquier adapter que localice columnas con `esImporte()` toma un CUIT como importe |
| `parseo-ar.ts` | **`centavosAImporte` y `importeACentavos` no son inversas** (punto vs. coma decimal) | Quien sume los importes canónicos para verificar totales obtiene `null`, Σ = 0 y **una verificación que "cuadra" contra la nada**. Falta `importeCanonicoACentavos()` |
| `parseo-ar.ts` | `parsearFecha` devuelve `null` para `dd/mm` y `dd-mm` | **Bancor e ICBC ilegibles a nivel fecha**. La firma necesita el **período**, no el año |
| `parseo-ar.ts` | Acepta doble signo (`-4.321,00-`), un solo decimal (rellena con `0`), y sin cota superior | Un token truncado se vuelve un importe **creíble y equivocado**; 17 dígitos explotan en el `insert` al final de un job de 45 páginas |
| `esquema.ts` | `credito`/`debito` declarados "siempre positivos" usan el **regex con signo** | Falta `importeNoNegativo`, y falta el `refine` que ata `importe` a la columna |
| `esquema.ts` | **`hayTotalesEnElExtracto: false` + `cuadraContraTotales: true` es un objeto válido** | El **verde-por-vacío está horneado en el contrato**. Necesita tri-estado |
| `esquema.ts` | `diferencias: string[]` es prosa | Prosa con importes adentro es la vía por la que un N2 llega a un log. Códigos, no texto |
| `hash.ts` | `filaNumero` (producto del parser) entra al material del hash | Un extracto reemitido con una fila más arriba **corre todos los hashes** y el reproceso **duplica el mes entero sin violar ninguna constraint** |
| `hash.ts` | `join(' ')` sobre campos ya `trim()`-eados | `['A B','C']` colisiona con `['A','B C']` |
| `texto-pdf.ts` | `requiereOcr` por **promedio** de caracteres | 10 páginas con texto + 40 escaneadas promedian por encima del umbral y reporta `false` **habiendo perdido 40 páginas** |
| `texto-pdf.ts` | Extrae líneas, no coordenadas | Insuficiente para 5 de 8 bancos |
| `package.json` | Exporta `./src/index.ts`, **que no existe** | El paquete es inimportable |
| **3 archivos** | **Importes y una glosa del extracto REAL en los comentarios** | ✅ **Ya corregido y verificado** (0 ocurrencias). Ningún control existente lo detectaba: el redactor mira logs, INV-8 mira el logger, **nadie mira los comentarios** |

> **CORRECCIÓN MEDIDA (2026-08-10):** esta sección afirma que las tres reglas se arreglan matcheando el
> **código de concepto** del banco. Se midieron las planillas de los ocho bancos y **solo Galicia trae código
> de concepto**; los otros traen el concepto como texto libre y tres no entregan planilla. El arreglo por
> código aplica a un banco de ocho. Ver `03-hallazgos-del-panel.md` §3.4.bis y `04-imputacion-contable.md`.

### 3.3. De las 14 reglas de la contadora — tres producen un asiento incorrecto

Auditadas contra el extracto real. **Los tres errores desaparecen matcheando por código de concepto en
vez de texto libre**, y el Excel de Galicia trae ese código (10 grupos, 34 conceptos en un mes).

| Regla | Error | Por qué |
|---|---|---|
| **3 — IVA → crédito fiscal** | Un match por el texto "IVA" captura también `PERCEP. IVA` y `PERCEPCION RG n`. **Una percepción no es crédito fiscal**: es pago a cuenta | Crédito fiscal inflado + percepciones nunca registradas = saldo a favor perdido. **Ella lo hace bien en su papel de tarjeta**, donde separa las dos cuentas: el error está en el documento, no en su criterio |
| **7 — Acreditamiento de haberes → Sueldos a pagar** | Bajo el mismo grupo convive `SERVICIO ACREDITAMIENTO DE HABERES`, que es **la comisión del banco por el servicio** | Manda una comisión bancaria a un pasivo laboral: subimputa gastos y cancela un pasivo que nadie pagó |
| **11 — Acreditaciones de tarjeta → Deudores por ventas** | La acreditación llega **neta** de comisión, arancel, IVA y retenciones | Deudores queda con saldo residual permanente; comisiones, IVA y retenciones **nunca se registran**. Es **el mismo problema que ella resolvió con maestría del lado pagador** (tarjeta corporativa). La asimetría es el hallazgo estructural |

**Y falta cobertura:** las 14 reglas no cubren el **pago de tarjeta corporativa** (débito real y
recurrente, y el tema de su tercer documento), suscripción y rescate de FCI, percepciones, anulaciones y
reversos, compras con débito, débitos automáticos, préstamos, moneda extranjera, movimientos en cero, e
intereses por descubierto.

---

## 4. Arquitectura

**Qué se generaliza ahora y qué no.** No existe una tabla común entre los 7 bancos (§2.1): generalizar la
**interpretación** sería inventar. Lo que ya tiene **tres casos reales cada uno** es el *toolkit de
reconocimiento de tabla* y el *pipeline de verificación*. Entonces: **se generaliza el pipeline y el
toolkit; la semántica nunca.** El "segundo banco" que habilita cada generalización es el segundo de **esa
familia**, no el segundo del proyecto.

```
packages/ingesta/src/
  index.ts                       ← FALTA (el package.json ya lo exporta)
  pipeline/
    ingestar-extracto.ts         ← orquestador PURO, sin I/O de base ni de disco
    registro-adaptadores.ts      ← ÚNICO archivo que se toca al sumar un banco
    identificar-banco.ts         ← por huella del CONTENIDO, nunca por ruta ni nombre
  pdf/
    texto-pdf.ts                 ← extraerTexto() + extraerItems() POSICIONAL
    tabla-posicional.ts          ← anclar columnas en el encabezado, agrupar por y, ensamblar celdas
    tabla-ancho-fijo.ts          ← cortar por offsets de carácter
  verificacion/
    invariantes.ts               ← verificarAritmetica(): V1..V13
    reporte.ts                   ← códigos, nunca valores
  planilla/
    excel-banco.ts               ← lector por banco: xlsx | biff | texto-tsv | ninguno
    cruzar-pdf-excel.ts          ← multiset + enriquecimiento
    exportar-planilla.ts         ← el primer entregable útil para ella
  adaptadores/{galicia,santander,macro,bancor,icbc,nacion,bbva}.ts
  esquema.ts  hash.ts  parseo-ar.ts
```

**Contrato del adapter** — lo que hace que el banco 3 no toque a los dos primeros:

```ts
export type FamiliaLayout = 'columnas-posicionales' | 'ancho-fijo' | 'imagen';
export type CadenaDeSaldos = 'completa' | 'por_puntos_de_control' | 'no_disponible';

export type CapacidadesAdaptador = {
  familiaLayout: FamiliaLayout;
  cadenaDeSaldos: CadenaDeSaldos;   // Galicia 'completa'; ICBC/Bancor 'por_puntos_de_control'
  traeTotalesDeclarados: boolean;
  traeSaldoInicialDeclarado: boolean;
  traeSignoEnElImporte: boolean;    // Bancor: false → el signo SALE de la cadena
  traeFechaValor: boolean;
  traeReferencia: boolean;
  traeCodigoDeConcepto: boolean;
  anioEnLaFecha: boolean;           // Bancor/ICBC: false → se resuelve contra el período
  multiCuenta: boolean;
  multiMoneda: boolean;
};

export interface AdaptadorBanco {
  readonly banco: BancoCodigo;
  readonly version: number;                        // va al lote: habilita reproceso dirigido
  readonly capacidades: CapacidadesAdaptador;
  reconoce(doc: DocumentoPdf): 'seguro' | 'probable' | 'no';
  parsear(doc: DocumentoPdf): ResultadoAdaptador;  // PURO
}
```

**Tres reglas verificables por test de arquitectura:** ningún adapter importa a otro; todo `BancoCodigo`
tiene entrada en el registro **y** fixture; ningún adapter importa `packages/data`.
**Criterio de que la generalización no rompió nada: al sumar el banco N, los tests del banco 1 pasan sin
editarse.**

**`--banco` del CLI es una aserción del operador que se verifica, no una instrucción que se obedece.** Si
dos adapters dicen `seguro`, o ninguno supera `probable` → **falla el lote**.

**El adapter recibe una abstracción de fila, no `LineaConPagina[]`.** Es lo que permite que el día que un
banco necesite coordenadas no haya que reescribir la capa compartida ni los tests de los otros siete.

---

## 5. Qué capturar HOY

**El único test: si el Módulo 1 no lo captura hoy, el Módulo 2 vuelve al PDF.** Y para el cliente de mayor
volumen puede no haber PDF al que volver: **entrega el extracto en papel.**

### 5.1. Campos que faltan en `esquema.ts`

| Campo | Por qué no puede esperar |
|---|---|
| **`descripcionLineas: string[]`** (además de la concatenación) | Ahí viven el nombre y el documento de la contraparte, y el número de operación |
| **`contraparteDocumento` + `contraparteDocumentoTipo` + `contraparteNombre`** | **Las reglas 10, 12 y 13 son indecidibles sin él.** Y se extrae **del campo correcto**, no por longitud de dígitos: hay 271 corridas de 8 dígitos que son terminales y comercios, no documentos |
| **`conceptoGrupoCodigo` + `conceptoCodigo` + `conceptoNormalizado`** | Es lo que convierte reglas frágiles en determinísticas y **elimina los errores de las reglas 3 y 7**. Normalizar el concepto es del Módulo 1 (depende del formato), no del 2 |
| **`columnaOrigen: 'credito' \| 'debito'`** | El Módulo 2 necesita el dato del banco, no una interpretación. Y la asignación se apoya en **dos evidencias independientes** —posición y signo—: discrepar es un error, no algo que se resuelve por preferencia |
| **`titular` + `titularDocumento` + `titularCondicionIva`** | Validar que el extracto es del cliente correcto **antes** de imputar; resolver "mismo titular"; y la condición ante IVA condiciona el cómputo del crédito fiscal |
| **`referencias: Array<{tipo, valor}>`** con tipos cerrados (`factura`, `cheque`, `operacion`, `comercio`, `terminal`, `vep`) | En el PDF no hay columna de referencia: los identificadores viajan en la glosa **con forma distinta según el concepto**. El número de factura es lo que **empareja la comisión con su IVA** |
| **`anexos[]`** (bloque posterior al `Total`) | Cubre **tres períodos distintos** del extracto e incluye un renglón —crédito computable como pago a cuenta— que **no existe como movimiento** y no es derivable de ellos. **Prohibido que entre en la suma de movimientos**, o el impuesto queda contado dos veces y el asiento cuadra igual |
| **`jurisdiccion` declarada, y "no informada" ≠ "cero"** | Bancor y Macro nombran la jurisdicción del SIRCREB; **Santander no**. Si una sola cuenta "Retenciones IIBB" acumula jurisdicciones distintas, **cuadra todo y se descubre cuando el fisco provincial la rechaza** |
| **`cotizacion` + `cotizacionProvista: false`** | Un movimiento en USD necesita valor en pesos y **el extracto no lo trae**. El campo existe y se marca no provisto; no se deduce |
| **`saldoEsAcreedor`** derivado | Un saldo negativo **invierte la naturaleza de la cuenta**: el Banco deja de ser activo y es pasivo (descubierto) |
| **`esMovimiento` + `motivoExclusion`** | `lineasNoInterpretadas` cubre "no supe"; no cubre "supe y decidí que no es movimiento". Lo primero es un riesgo, lo segundo una **decisión auditable** |
| **`paginasDeclaradas`** vs. `paginas`, y `paginasSinTexto: number[]` | 26 vs. 25 en Galicia. Contado ≠ declarado significa **faltan hojas** |
| **`tipoFila`** | Sin esto no hay invariantes |
| **`adaptadorVersion`** en el lote | Reproceso dirigido. **Nunca en el hash** |

**Y un renombre que es un control, no estética:** `importe` → **`importeSignado`** o `efectoEnSaldo`.
`importe` a secas es el campo que alguien va a mandar al asiento sin pensar.

### 5.2. `fila_hash` — la resolución del conflicto del panel

Tres agentes discreparon. El tester lo dirimió midiendo: **los 326 grupos de líneas crudas ya son únicos
sin el número de fila** (326/326), porque el saldo corriente está dentro del texto crudo. Entonces:

```ts
hashFila({
  cuenta: { bancoCodigo, numeroNormalizado, moneda },  // NO la denominación: en Macro se repite
  fecha,                    // ISO
  importeSignado,
  saldo,                    // el discriminador REAL: es dato del banco, no del parser
  descripcionNormalizada,   // upper, sin acentos, líneas unidas con separador de unidad
  ordinalEnEmpate,          // 0 salvo empate GENUINO en todo lo anterior
})
```

Separador `` con el largo de cada campo en el material (elimina la ambigüedad de frontera). El
`ordinalEnEmpate` reemplaza al `filaNumero`: **insertar una fila no desplaza el hash de ninguna otra**, y
dos movimientos legítimamente idénticos siguen distinguiéndose. Cuando el banco no imprime saldo, el hash
pierde discriminación y eso queda **declarado en las capacidades**, no escondido.
`lineasCrudas` **sale del hash** y se queda como evidencia.

---

## 6. Verificación

### 6.1. Los invariantes

| # | Invariante | Nota |
|---|---|---|
| **V1** | `saldo(n−1) + importe(n) = saldo(n)`, **toda** fila | El más fuerte: **localiza la fila** ("se rompe entre la 142 y la 143, página 14"). Inmune a la compensación de dos errores opuestos. **Y en Bancor no es la red: es la fuente del signo** |
| **V2** | `Σcréditos = total declarado` **y** `Σdébitos = total declarado`, por separado | Más fuerte que V4: detecta un crédito cargado como débito por el mismo importe, que V4 no ve |
| **V3** | `saldo(1) − importe(1) = saldo inicial declarado` | Resuelve además la trampa de los dos saldos sin rótulo del encabezado: **por invariante, no por posición** |
| **V4** | `saldo inicial + Σcréditos − Σdébitos = saldo final` | El control que ella hace a mano |
| **V5** | Último saldo = saldo final declarado | Redundante con V1+V4 **a propósito**: si esos pasan y V5 no, el bug está en el parser de la línea de totales |
| **V6** | Toda fila: **exactamente un** importe (crédito xor débito) con su columna de origen | |
| **V7** | Fechas dentro del período y **no decrecientes** | Rompe también si un banco exporta `mm/dd` y se lee `dd/mm` |
| **V8** | `páginas = con_movimientos + sin_movimientos + anexo`; toda página con encabezado fue recorrida | **Nunca se cuenta con el número del pie** |
| **V9** | **Cobertura total de líneas**: cada línea queda asignada a exactamente una fila / encabezado / pie / total / anexo. Residuo = `lineasNoInterpretadas`, **debe ser 0** | El único que atrapa lo que V1–V5 no ven |
| **V10** | Los `filaHash` del lote son distintos entre sí | |
| **V11** | Multi-cuenta: V1–V5 cierran **por cuenta**; el cambio de cuenta solo en un límite declarado | Macro |
| **V12** | Una cuenta, una moneda; **jamás** se suma entre monedas | Macro y Santander traen ARS y USD |
| **V13** | `archivoHash` no procesado antes para ese cliente; lote del mismo período y cuenta → **conflicto declarado** | |

**El tri-estado, que es la mitad del valor:** `estado: 'cuadra' | 'no_cuadra' | 'no_verificable'`.
`no_verificable` **exige** entrada escrita en el roster con el motivo, y un test falla si la cantidad de
`no_verificable` crece sin que crezca la lista de motivos. Sin eso, en tres sprints todos los bancos están
ahí.

**`verificarAritmetica` es una función pura que CALCULA el veredicto.** Ningún adapter declara si cuadró.

### 6.2. Cuándo falla el lote y cuándo se acepta con observaciones

**Falla (`rechazado`, cero filas persistidas):** PDF sin texto; banco no reconocido o dos adapters lo
reclaman; falta el ancla de columnas en una página con datos; rompe V1, V2, V4 o V6; `lineasNoInterpretadas`
en zona de movimientos; fecha fuera del período; multi-cuenta sin cuenta asignable; colisión de `filaHash`.

**El motivo es de negocio, no de purismo: medio extracto es peor que ninguno.** Ella arma el asiento
contra el saldo, y un lote parcial produce un asiento que cierra mal y se descubre **al cierre de
ejercicio** — que es literalmente el dolor que originó el proyecto. Corolario del contador:
**un asiento balanceado sobre datos incompletos es peor que ningún asiento, porque nadie lo va a revisar.**

**Se acepta con observaciones (`procesado_con_observaciones`, cuarto valor del enum, que hay que agregar):**
el banco no publica totales y la cadena cierra; cadena `por_puntos_de_control` que cierra por tramos;
páginas sin movimientos; anexos no interpretados **fuera** de la zona de movimientos; falta `fechaValor` o
referencia que el banco no trae; el Excel falta o difiere.

**"0 movimientos" nunca es `procesado`.** Es `rechazado` con motivo.

### 6.3. El test de mutaciones — la pieza más importante

Un fixture afirma lo que *nosotros* creíamos el día que lo escribimos; un fixture escrito con un
malentendido lo consagra y el test verde lo certifica para siempre. La línea `Total` afirma lo que **dice
el banco**, sobre el archivo real, en **todos** los archivos.

`mutaciones.test.ts` toma un fixture bueno, le aplica una mutación, y **la aserción es sobre el detector,
no sobre el parser**:

| Mutación | Detector que **tiene que** ponerse rojo |
|---|---|
| borrar la fila 143 | cadena **y** total de débitos |
| duplicar la fila 9 | cadena, eslabón 10 |
| invertir el signo de un débito | cadena **y** chequeo de signo |
| intercambiar importe ↔ saldo | cadena, primer eslabón |
| **mover la última línea de descripción al bloque siguiente** | **partición + regla del par** |
| cambiar un dígito de la línea `Total` | comparación contra Σ |
| borrar la línea `Total` | `no_verificable`, **nunca `cuadra`** |
| borrar una página entera | continuidad de páginas + cadena |
| reemplazar el importe por el CUIT de la línea de arriba | cadena |
| vaciar 2 de 5 páginas | `requiereOcr` **por página** |

**Un detector que no se pone rojo ante su mutación no existe, aunque tenga un test verde al lado.**

### 6.4. El peor modo de falla, y no es el que parece

**La glosa corrida: importe correcto, descripción del movimiento vecino.** Gana porque:

1. **Sobrevive a todas las redes aritméticas — y las redes son exactas.** Los 326 importes intactos, los
   dos totales intactos, la cadena intacta, el conteo intacto. Verde perfecto, dato equivocado.
2. **La descripción ES el producto.** Un parser que acierta los importes y corre las glosas entrega
   exactamente lo que el Excel ya daba, con la firma de haber leído el PDF.
3. **Propaga a un error de imputación y a una atribución falsa**: manda un pago a un socio a Proveedores
   en vez de a Cuentas particulares —el único control que ella hace siempre— y le pega el documento de un
   tercero al movimiento de otro.
4. **El cruce contra el Excel, como se diseña por instinto, no lo agarra**: solo 2 de 326 filas están en
   la misma posición.

**Lo atrapan tres tests, y hacen falta los tres:** partición exacta del cuerpo; **el par (importe, saldo)
sale de la ÚLTIMA línea del bloque** (con un fixture donde una línea de continuación contiene un importe);
y ninguna línea de continuación arranca con fecha.

### 6.5. El cruce con el Excel

**Puerta de identidad antes de comparar nada**: misma cuenta, mismo período, misma moneda. Discrepancia →
`RECON_ARCHIVOS_NO_COMPARABLES` y **cero comparación**. Que en la carpeta de origen haya un `.xls` de un
banco dentro de la carpeta de otro no es anécdota: es el caso de prueba.

**Clave `(fecha, importe_signado, saldo)`** — 326 de 326 distintas. **Nunca posicional. Nunca la cadena
de saldos sobre el Excel** (se rompe en 217/325 estando perfecto).

| Bucket | Qué significa | El test |
|---|---|---|
| `enAmbos` | lo normal | debe ser > 0 (si es 0, la clave está mal) |
| `soloEnPdf` | **el Excel perdió filas** | **NO falla** — es la feature |
| `soloEnExcel` | el Excel tiene algo que el PDF no | **FALLA siempre**: el PDF es la autoridad |

Esa asimetría es todo el diseño: `soloEnExcel > 0` es la red externa más barata contra la fila perdida.
Y si `soloEnPdf > 0`, se verifica **la forma**: esas filas se agrupan en la cola del período (lo que ella
denunció); si están dispersas, `RECON_PERDIDA_NO_ESPERADA` — porque una pérdida en el medio del mes no es
el bug del banco, es el nuestro.

---

## 7. Seguridad del camino de ingesta

**H-2 marcó la ingesta como el camino más riesgoso del sistema. Este es el detalle.**

### 7.1. La decisión estructural: el dato crudo va a una tabla satélite

Si `fila_origen` vive en `movimiento_bancario_crudo` y es N2R (y lo es: contiene 113 CUIT de terceros),
**toda lectura de movimientos** pasa al régimen auditado. Auditar 326 filas por pantalla no es un control:
es ruido que **destruye** la capacidad de detectar al administrativo que se baja la cartera. Y no se puede
resolver con grant por columna, porque todos los usuarios comparten el rol de base `app_request`.

| Tabla | Nivel máx. | Régimen |
|---|---|---|
| `cuenta_bancaria` | N2 | RLS normal, listable |
| `cuenta_bancaria_identificador` | **N2R** | policy con `has_role_on`, lector auditado |
| `lote_ingesta` | **N1 a propósito** | listable, contable y **loggeable** sin auditoría |
| `movimiento_bancario_crudo` | N2 | RLS normal; el contador trabaja acá |
| `movimiento_origen_crudo` | **N2R** | policy con `has_role_on`, lector auditado |

**Es una enmienda a ADR-0001 §5.1** (que pone `fila_origen` dentro del movimiento) y hay que escribirla.
Y `lote_ingesta` se mantiene **sin una sola columna ≥ N2** para que la observabilidad del pipeline no
requiera auditoría — por eso **el nombre original del archivo no se guarda ahí**.

### 7.2. INV-6 con el formato real: el control, en orden

1. `--cliente <uuid>` obligatorio. Sin cliente no corre.
2. **Identidad y guard antes de abrir el archivo** (si va a fallar, que falle sin el contenido en memoria).
3. `archivoHash`; si ya existe para ese cliente → no-op idempotente.
4. Se crea el lote: **es el ancla de todo el resto**, incluso si se rechaza.
5. Sin texto → rechazo `requiere_ocr`. Cero filas, cero objeto.
6. **Lectura de la carátula SOLO por etiqueta.**
   > **Así se rompe por patrón:** el archivo real tiene **113 corridas de 11 dígitos** (CUIT de
   > contrapartes) y **dos CUIT con guiones**, uno en la carátula y otro en el cuerpo. Un control del
   > tipo "¿aparece el CUIT del cliente en este archivo?" da **verdadero para un extracto de otro
   > cliente** donde el nuestro figura como contraparte — que es el caso más común. **Ese control no
   > valida nada y da la sensación de validar.**
7. Resolución **siempre acotada al cliente declarado**, por HMAC del CBU con pepper de servidor. La
   consulta **nunca** pregunta "¿de quién es este CBU?": preguntarlo requeriría saltear la RLS y sería el
   oráculo cross-tenant.
8. Cuatro salidas: una coincidencia → sigue · cero con cuentas registradas → `cuenta_no_pertenece_al_cliente`
   · cero sin cuentas → `cuenta_no_registrada` (**alta explícita por humano, nunca automática**: si el
   archivo crea la cuenta, el archivo define la verdad y el control se vuelve tautológico) · más de una →
   `cuenta_ambigua`, revisión humana.
9. El **mismo CBU en dos clientes** no lo puede ver esa consulta. Lo detecta un **job de mantenimiento**
   que cuenta clientes distintos por HMAC y **emite un incidente con conteos, sin nombrar a nadie**.
10. Verificación de totales **antes** de commitear.
11. **Recién ahí se guarda el objeto.** Guardar primero "para no perder el archivo" escribe el PDF de un
    cliente bajo el prefijo de otro, y ahí el socio del segundo se lo baja **legítimamente**.

**Por qué el error no puede decir a qué cliente pertenece:** el radio de daño es estudio→estudio, así que
decirlo filtra la cartera de un competidor; confirma la existencia de un cliente a quien no tiene
membresía (mismo razonamiento del 404 vs. 403); y **el operador no lo necesita** — tiene el archivo y sabe
quién se lo mandó.

### 7.3. El PDF se guarda

Bucket privado sin listado, clave `cliente/<cliente_uuid>/extracto/<lote_uuid>.pdf` — **el nombre es el
`lote_id`, no el `archivo_hash`**: una clave con el hash del contenido convierte el storage en un oráculo
de "¿tenés este archivo exacto?". Cifrado en reposo del proveedor, **no envelope** (el envelope exige la
DEK en el proceso que atiende pedidos, y un RCE ahí ya la tiene: complejidad por cero reducción).
**Sin borrado automático**: el plazo legal es un hueco (`no tengo esa fuente cargada`), así que la
retención es configurable por estudio con default indefinido y el borrado es humano, de rol `socio`, con
motivo y auditado. **Descarga: `socio` y `contador`. `administrativo` puede ingestar y NO puede
descargar** — el escenario H-8 es literalmente el administrativo bajando 40 extractos en su última semana.
Emisor único de URL firmada, TTL ≤ 5 min, auditoría **antes** de firmar, y **alerta de volumen** (sin eso,
H-8 queda registrado y nadie lo mira).

### 7.4. El logger no cubre los campos de este módulo

`esClaveSensible` compara por **pertenencia exacta**: `saldo` está en la lista, **`saldoInicial`,
`saldoFinal`, `credito`, `debito`, `denominacion`, `totalCreditosDeclarado` no**. Y **no hay detector de
importe**. Combinado: `logger.info('ingesta.cuenta', { saldoFinal })` **compila, pasa el redactor y
publica el saldo del cliente**.

Arreglo inmediato: sumar esos nombres al blocklist + un detector `importe_ar` para
`\d{1,3}(\.\d{3})+,\d{2}`. **Arreglo de fondo: pasar de blocklist a allowlist** — para los eventos del
Módulo 1, el segundo parámetro del logger es una **unión cerrada de campos permitidos** y cualquier otra
clave **no compila**.

**Y la técnica que reemplaza al "logueá la línea así la vemos":** loguear la **forma**
(`99/99/99 AAAAAAA AAAA 9999999999 -9.999.999,99 999.999,99`), no la línea. Dígito→`9`, mayúscula→`A`,
minúscula→`a`, puntuación intacta. Alcanza para arreglar el adapter y no contiene ni un dato. Va a
`packages/shared/src/observabilidad` con un test: `forma()` de cualquier texto no matchea ningún detector.
**Toda la especificación estructural del informe de seguridad se construyó así, sin leer una línea real.**

### 7.5. Fixtures

**No se edita el PDF real: se escribe un generador** desde una especificación. Se conserva la **forma**
(páginas, encabezado repetido, etiquetas de carátula, estructura multi-línea con su distribución real, las
cuatro notaciones de signo, las dos fechas del período **pegadas sin separador**, la línea de totales que
**cuadra**, los bloques que no son movimientos, y una variante **multi-cuenta** aunque la muestra tenga
una sola). Se reemplaza todo el resto, con **importes regenerados, no escalados** (escalar es reversible
por división contra los totales publicados) y **metadatos del PDF vacíos** (el XMP arrastra el nombre del
titular y nadie lo mira).

**Gate `pnpm fixtures:verificar`, bloqueante:** ningún token del real aparece en el fixture **comparando
normalizado** (sin normalizar da falso negativo — pasó en este mismo trabajo); CUIT y CBU con verificador
inválido; **allowlist de nombres, no detector** (el redactor no puede reconocer una razón social); el
fixture cuadra; barrido INV-8 con el set del fixture; y `git check-ignore` sobre la ruta destino tiene que
decir "no ignorado".

---

## 8. Migración `0004_ingesta.sql`

**Cinco tablas** (§7.1), todas con `cliente_id`, más el catálogo `banco` (N0).

**Lo que cambia respecto del contrato de ADR-0001 §5.1:**

1. **`lote_ingesta.cuenta_bancaria_id` NO se crea.** Un archivo trae **N cuentas** → tabla
   `lote_ingesta_cuenta`, con los contadores y la verificación **por cuenta**, no por archivo.
2. **`movimiento_bancario_crudo.cuenta_bancaria_id` es NOT NULL**, y apunta con **una FK de tres
   columnas** a `lote_ingesta_cuenta (cliente_id, lote_ingesta_id, cuenta_bancaria_id)`. Eso convierte en
   **invariante de integridad referencial** que la cuenta de un movimiento sea una de las detectadas en
   ese lote, de ese cliente — la única defensa que sobrevive a `BYPASSRLS`, a `COPY` y al bug de
   aplicación.
3. **`unique (cliente_id, cuenta_bancaria_id, fila_hash)`**, no `(cliente_id, fila_hash)`.
4. **`fila_origen` va a `movimiento_origen_crudo`**, tabla satélite N2R.
5. **`estado`** suma el cuarto valor `procesado_con_observaciones`, y **`acceso_auditoria.accion` suma
   `rechazo`** — un rechazo no es una escritura, y registrarlo como tal es asentar algo falso en la única
   tabla append-only del sistema. Más el **check constraint** sobre `accion`, que hoy no existe: un valor
   mal escrito entra y el evento **desaparece de toda consulta del rastro**.
6. **La identidad de la cuenta se separa de sus identificadores**: `cuenta_bancaria` (estable) +
   `cuenta_bancaria_identificador` (serie con vigencia). Los números y CBU cambian, y un extracto de hace
   ocho meses tiene que resolver con **el identificador vigente entonces**.
7. **El CBU se guarda hasheado** (HMAC con pepper de servidor) para búsqueda, más `ultimos4` para mostrar.
   Regla general: *un identificador que solo hace falta para matchear se guarda hasheado; uno que hace
   falta para consultar afuera se guarda entero, N2R, con chequeo de rol y auditado.*
8. **Todas las unicidades por cliente.** Cero unicidades globales sobre un identificador de tercero.
9. **Los siete renglones** de ADR-0001 §5 en las cinco tablas, **más los cuatro** de la plantilla ampliada
   en las dos satélites N2R.
10. **En la misma migración**, las entradas en `clasificacion-campos.ts` y en `LECTORES_AUDITADOS`. Sin
    eso, CI rojo — y es lo correcto.

`0005` en adelante: plan de cuentas, reglas modelo/cliente, `cliente_socio`, ejercicio, padrón de
terceros, FCI con inventario PEPS, y renglones de resumen de tarjeta. **Todo aditivo.**

---

## 9. Plan por etapas

| Etapa | Qué | "Hecho" verificable |
|---|---|---|
| **E-1** | **Condiciones de salida de §10** | Ver §10. Bloqueante |
| **E0** | `0004_ingesta.sql` + registro de clasificación | `catalogo.test.ts` verde con las 5 tablas (R1–R15); test de aislamiento; `pnpm verificar` verde |
| **E1** | Arreglar `parseo-ar` / `esquema` / `hash` / `texto-pdf` (§3.2) + `verificarAritmetica` pura + `mutaciones.test.ts` | Las 10 mutaciones ponen rojo a su detector; round-trip de importes en los dos sentidos; `dd/mm` resuelto contra el período |
| **E2** | Toolkit: `extraerItems()` posicional, `tabla-posicional`, `tabla-ancho-fijo` | Tests con las tres trampas reales: importe partido en dos items, fecha+descripción en un item, código de 4 dígitos en `Origen` |
| **E3** | **Adapter Galicia** | 326 filas, V1–V10 verde, **0** líneas no interpretadas, dos corridas → hashes idénticos. Fixture sintético en el repo |
| **E4** | Persistencia + CLI | Corre con `app_request` (R20), staging por lote (R21), auditoría escrita, **dos corridas → 326 filas, no 652**. INV-6 completo |
| **E5** | **Export a planilla** | **Una hoja, todas las columnas, filtrable por concepto**, y el saldo final coincide con su PDF. Es el dolor #1 |
| **E6** | Cruce con el Excel | Dice "coinciden" en el par real **y** detecta la mutación en el fixture |
| **E7** | **Santander (banco 2)** | **Los tests de Galicia pasan sin editarse.** Sube al toolkit el ensamblado de celdas fragmentadas y la fecha en otra banda `y`, con dos casos reales. Y el lector de su "Excel" que es TSV |
| **E8** | **Macro (banco 3, multi-cuenta, ancho fijo)** | 3 cuentas detectadas **por número**, V1–V5 por cuenta, ninguna suma cruza monedas, período no calendario. De E3/E7 se toca **solo** el registro |
| **E9** | Bancor, ICBC, Nación | Familia ancho fijo ya generalizada. **Bancor sin signo: el importe SALE de la cadena de saldos.** `cadenaDeSaldos: 'por_puntos_de_control'` |
| **E10** | BBVA / Credicoop | BBVA declara `imagen` y **falla con código**; Credicoop no tiene PDF. La decisión de OCR se abre con el dato en mano: 6 páginas, un cliente, uso bajo |

**El certificado de corrida.** `packages/ingesta/tests/reales/ultima-corrida.json`, **commiteado**, con
solo N1 (conteos, hash truncado, estado, motivo). CI falla si no existe, si falta un banco del roster, si
algún banco no está en `cuadra` o `rechazado`-con-motivo, o si el digesto de filas no coincide con el que
produce el parser actual sobre el fixture equivalente. **Así CI no puede estar verde a menos que alguien
haya corrido la suite real y commiteado su resultado redactado.** El PDF nunca viaja; el hecho de que se
lo corrió, sí.

---

## 10. Condición de salida antes de la primera línea del adapter — **CERRADA**

**Estado: las 12 cerradas** (la 3 es del titular). `pnpm verificar` verde: **277 tests + 4 todo**, los 18
invariantes SQL con las tres credenciales, y el gate de fixtures con sus 7 chequeos.

| # | Qué | Estado |
|---|---|---|
| 1 | **Sacar los datos reales de los comentarios** de `packages/ingesta/src/*` | ✅ verificado, 0 ocurrencias |
| 2 | **`.gitignore` anclado, sin las negaciones de `fixtures/`** | ✅ |
| 3 | **Commitear el `.gitignore`** antes de `packages/` | ⏳ **del titular** (no hago commits) |
| 4 | **Barrido de detectores sobre el repo** en pre-commit y en CI | ✅ `tools/barrido-fuga.ts`, dos modos, 22 tests. Cuatro correcciones salieron de probarlo — ver ADR-0002 §H.3.bis |
| 5 | `0004_ingesta.sql` + catálogo en verde **antes** del parser | ✅ 7 tablas; 31 catálogo + 16 aislamiento. Encontró la **trampa de `for all`** (ver abajo) |
| 6 | **Test INV-6 completo**, cuatro casos, tres aserciones cada uno | ✅ `resolver-cuenta.ts` + 11 tests |
| 7 | **Allowlist de campos del logger** + detector de importe + `forma()` | ✅ |
| 8 | **INV-13:** ninguna `descripcion` producida matchea los detectores | ✅ `glosa.ts` + 17 tests. Es lo que **sostiene** que `descripcion` sea N2 |
| 9 | `packages/almacenamiento` con emisor único + orden "resolver → almacenar" | ✅ 26 tests, incluida la ida y vuelta real contra MinIO |
| 10 | **Fixture sintético con su gate** `pnpm fixtures:verificar` | ✅ 7 chequeos + 13 tests; el fixture es **reproducible byte a byte** |
| 11 | `accion='rechazo'` + check constraint; guard llamado desde el CLI; R18 extendido | ✅ `apps/cli` + 10 tests |
| 12 | **`verificarAritmetica` pura + las mutaciones** | ✅ 11 mutaciones ponen rojo a su detector |

### 10.1. Los seis hallazgos que salieron de cerrarlas

Ninguno lo encontró una revisión: **los seis los encontró un test o el propio control al probarse**.

1. **Bug de seguridad: la trampa de `for all`.** Las policies permisivas de Postgres se combinan con `OR`
   y `for all` incluye `SELECT`. La policy de escritura de `movimiento_origen_crudo` admitía al
   `administrativo` —ingestar es su trabajo— y eso **anulaba** la policy de lectura restringida: el
   administrativo leía las filas crudas con los CUIT de las contrapartes, o sea H-8 sin descargar nada. La
   policy de lectura estaba bien escrita; **el control se veía correcto en la migración y no existía en la
   base.** Corregido con escritura por operación, `0005` para `credencial_fiscal`, y un test de catálogo que
   prohíbe **el patrón**, no la instancia.
2. **El barrido daba verde estando ciego.** Leía solo `.txt`, y el material real son PDF y Excel: al plantar
   un importe real **no lo detectó**. Se descubrió al probar el control, no al escribirlo.
3. **`LECTORES_AUDITADOS` era decorativo.** Guardaba *strings*, y el de `credencial_fiscal` apuntaba a un
   archivo **que no existía**. El test pasaba porque preguntaba si la tabla tenía entrada, no si el lector
   existía. Ahora guarda la referencia a la función: si no existe, no compila.
4. **`ACCIONES` (TS) y el check constraint (SQL) divergían**: faltaba `uso_credencial`, que el código emite.
   Todo registro de uso de credencial fiscal habría fallado el día que se integrara AFIP.
5. **El truncamiento del layout produce identificadores parciales.** El fixture generado mostró un CBU
   cortado a 13 dígitos por el ancho de la columna: no matchea CBU (22), ni CUIT (11), ni documento (7-8), y
   **sobrevivía en la descripción**. Se agregó el patrón de corrida larga.
6. **El fixture salía con fechas desordenadas**, lo que habría hecho fallar V7 por un defecto del fixture y
   no del adapter — y el camino de menor resistencia habría sido relajar V7.

### 10.2. Lo que quedó explícitamente sin hacer

- **No hay ningún adapter de banco.** El CLI rechaza con `adapter_no_disponible` y lo dice. La alternativa
  —guardar el archivo y dejar el lote en `procesado` con cero movimientos— produce un lote que nadie vuelve
  a mirar, que es el peor modo de falla del módulo.
- **Las 4 mutaciones de texto** siguen como `it.todo`: necesitan un adapter para tener sujeto.
- **El pepper de identificadores** es de desarrollo y está en `.env.example`. En producción viene del almacén
  de secretos. Rotarlo obliga a recalcular `cbu_hmac` de todas las cuentas: es dato derivado, no credencial.

---

## 11. Lo que hay que pedirle a Laura

| Qué | Para qué | Urgencia |
|---|---|---|
| **PDF de Santander de 2-3 meses** | Banco 2, el que fuerza la generalización | Alta |
| **El Excel del mismo período que cada PDF** | Habilita el cruce y el testigo independiente | Alta |
| **Confirmar las tres reglas con error** (3, 7, 11) | Son de su criterio, no nuestro. La 11 le está costando plata hoy | Alta |
| **Padrón de CUIT de socios por cliente** | **Precondición de las reglas 12 y 13**, el mayor volumen. Sin esto todo va a Proveedores y las cuentas particulares no existen | Alta |
| **Inventario PEPS de apertura por fondo** | **Lo único que no se puede reconstruir después.** Un resultado de FCI sobre inventario que arranca en cero está mal y parece bien | Alta |
| **Liquidación del adquirente de tarjetas** | Sin ella la regla 11 queda mal para siempre. **No está en ningún módulo del diseño** | Alta |
| **Formato de importación de su sistema contable** | Define la salida del Módulo 2 — y si acepta un renglón por movimiento, el asiento agregado deja de ser necesario y se gana trazabilidad **gratis** | Media |
| **La provincia de cada cliente** | Sin jurisdicción, ninguna respuesta de IIBB es válida. `knowledge/provincial/` está vacío | Media |
| **¿Un archivo con una sola cuenta no resuelta se rechaza entero?** | Afecta su flujo, no la seguridad | Media |
| **El canal de entrega de extractos** | Hoy circularon por un servicio de terceros sin entrada en `registro-terceros.md`. **Decisión del titular, no mía** | Media |

---

## 12. Abierto

- **OCR para BBVA**: 6 páginas, un cliente, uso bajo. Se decide con el dato en mano, no antes.
- **Convenio Multilateral**: el fiscal coincide en no cargarlo, pero **corrige la premisa**: no aparece
  *en la entrevista*, **sí aparece en los extractos** (un banco publica renglones por jurisdicción). El
  modelo multi-jurisdicción **no se revierte**.
- **El hueco de `knowledge/` que nadie tenía anotado**: el **impuesto sobre los débitos y créditos** es el
  concepto fiscal más frecuente del extracto, está en los 6 bancos legibles, y **no figura en
  `_FUENTES.md`**. Subir a prioridad alta. Y el **régimen de recaudación bancaria provincial** está en
  prioridad baja cuando lo consume el **Módulo 1, el primero que se construye**.
- **El sujeto de dato más numeroso del sistema no es el cliente: es la contraparte** — 113 terceros en un
  archivo de un mes de un cliente, de los que se conserva nombre y documento, y que no tienen ninguna
  relación con el estudio. **Es el hueco de mayor volumen y el que menos figura en cualquier conversación
  de este producto.** Qué corresponde: `no tengo esa fuente cargada`.
- **Riesgo residual declarado:** un RCE en el proceso servidor entrega el pool de `app_request`; el CLI es
  un punto de suplantación acotado por membresías mínimas y auditoría, no eliminado; el cifrado del PDF es
  en reposo del proveedor, así que una credencial de storage comprometida entrega los PDF en claro.
- **Ajuste por inflación**: si corresponde al período, **cambia todos los importes** de las cuentas de
  resultado que estas reglas alimentan. Es el hueco de mayor impacto contable y hoy está abierto.

---

_El contenido fiscal y contable de este plan es **criterio a validar**, no doctrina: `knowledge/` está
vacío y ninguna norma se cita por número. **Validar con profesional matriculado.**_
