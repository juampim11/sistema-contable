# Motor de reconocimiento de tipo de movimiento — diseño

> Complemento de `04-imputacion-contable.md`. Ese documento define **qué cuenta y qué lado**; este define **cómo
> se reconoce el tipo** con la evidencia que cada banco entregue.
>
> Todo lo que sigue se cruzó contra los **32 conceptos medidos** del vocabulario de Galicia
> (`02-formato-galicia.md` §14) y las **14 reglas** de la contadora. Los hallazgos de §0 salieron de ese cruce y
> **cambian el alcance del Módulo 2.**

---

## 0. Tres hallazgos medidos, antes de la arquitectura

### 0.A 🔴 La trampa del `contains` no es teórica: son tres pares del vocabulario real

| Literal A | Tipo | Literal B | Tipo |
|---|---|---|---|
| `EXTRACCION EN AUTOSERVICIO` | 9 extracción de efectivo | `COMISION EXTRACCION EN` (truncado) | 2 comisión |
| `CHEQUE PAGADOR NRO.` | 12 cheque | `COMISION CHEQUE PAGADO POR` | 2 comisión |
| `IMP. CRE. LEY 25413` (21 mov., **débito**) | 1 impuesto | `DEV.IMP.CRED.LEY 25413` (3 mov., **crédito**) | 1 **reversa** |

Cualquier regla `includes('EXTRACCION')`, `includes('CHEQUE')` o `startsWith('IMP')` manda la comisión a la
cuenta del efectivo y la devolución al lado equivocado — **y el asiento cuadra igual**.

Y el dato que resuelve el diseño: los tres pares son **seguros bajo prefijo anclado al inicio** y **letales bajo
`contains`**. De ahí la regla dura de §3.

### 0.B 🔴 Cuatro de los 14 tipos tienen CERO evidencia en el corpus medido

Los tipos **4** (intereses de financiación), **5** (SIRCREB), **8** (depósitos en efectivo) y **14** (cheque
rechazado) no tienen **ningún** literal entre los 32 de Galicia. **No se pueden escribir hoy**: hacerlo sería
inventar vocabulario del banco. Quedan declarados como `sinEvidenciaEnElRoster` con su motivo, y hay una
propiedad de test que exige esa declaración explícita — si no, el hueco desaparecería de la vista.

### 0.C 🔴 Los 14 tipos NO cubren el material del piloto: 31 movimientos quedan afuera

| Concepto medido | Movimientos | Por qué no entra |
|---|---|---|
| `RESCATE FIMA` + `SUSCRIPCION FIMA` | 14 | **FCI.** La contadora lo nombró en la entrevista, pero **no está en el documento de 14 reglas** |
| `PERCEP. IVA` + `PERCEPCION RG 5617/24` | 6 | **Percepción de IVA.** No es el tipo 3 (IVA de gastos) ni el 5 (SIRCREB, que es IIBB) |
| `COMPRA DEBITO` | 11 | Compra con tarjeta de débito. **No es** extracción de efectivo |

Consecuencia de diseño: el motor tiene que poder decir **"reconozco el concepto y no tengo tipo para él"**, que
es un estado **distinto** de "no reconozco el concepto". El primero es un **hueco de producto**; el segundo, un
literal nuevo. Sin esa distinción, el hueco se disfraza de error de parser.

---

## 1. Arquitectura: dos capas y un vocabulario canónico en el medio

**El error a evitar:** 14 tipos × 8 bancos = 112 reglas. El mismo criterio contable —"una comisión bancaria es
una comisión bancaria"— queda escrito ocho veces, las ocho copias divergen, y **cada copia pasa su propio test**.

```
MovimientoBancarioCrudo (Módulo 1, N2)
        │
        ▼   capa POR BANCO — DATOS, no lógica de decisión
   léxicoDelBanco:   evidencia del banco → ConceptoCanonico
        │            (código, o literal enumerado, o prefijo con cola)
        ▼   capa ÚNICA — sin nombre de banco, una tabla y una función
   catálogoCanónico: ConceptoCanonico → { tipo, polaridad, ladoEsperado, quéDecideLaPersona }
        │
        ▼
   Reconocimiento (unión discriminada de tres clases — §5)
        │
        ▼   `04-imputacion-contable.md` + plan de cuentas del cliente
   PropuestaDeAsiento
```

Lo específico del banco es **una tabla de literales**; lo contable se escribe **una vez**. Costo estimado: ~40
conceptos canónicos + 14 tipos + 30-60 literales por banco ≈ **300 filas de datos** contra 112 reglas con regex.

### 1.1. Por qué el nivel intermedio no es de más

| Alternativa | Por qué no |
|---|---|
| 14×8 reglas | El criterio contable replicado ocho veces, divergiendo sin que ningún test lo vea |
| El léxico mapea **directo** a los 14 tipos | Se cae §0.C: un concepto reconocido sin tipo no tendría dónde ir y caería en "no reconocido", **escondiendo un hueco de producto detrás de un síntoma de parser**. Y se pierden tres cosas más: el espejo de la reversa, la distinción de imputación (`comision_transferencia` ≠ `comision_cheque_pagado` pueden ir a cuentas distintas), y el cruce contra el anexo, que discrimina el impuesto **sobre débitos** del **sobre créditos** |
| Tabla de reglas con **regex editable** en la base | Convierte el criterio contable en dato de runtime sin review, sin test y sin versión. Y una tabla compartida y escribible **es literalmente H-6** |
| Clasificador estadístico o LLM sobre la glosa | Prohibido por CLAUDE.md §1.3. E inútil acá: la evidencia sería "el modelo dijo", el corpus son 32 filas, y la glosa es N2 → no puede salir a un servicio externo |

### 1.2. El assert que la RLS **no** cubre

Un usuario con membresía en el cliente A **y** en el B puede cargar legítimamente el padrón de A y el
movimiento de B: **las dos lecturas pasan la RLS**. Eso es H-6 en runtime, no en reposo.

```ts
if (ctx.clienteId !== mov.clienteId) throw new Error('contexto_de_otro_cliente');
```

---

## 2. Precedencia de la evidencia, y la confianza sin score inventado

**El código gana sobre el texto**, y el motivo es medible: el vocabulario de texto **no es inyectivo** sobre los
conceptos (varios pares de los 32 literales son el mismo concepto truncado a 27 caracteres), y el código sí lo
es por construcción — es la clave del sistema del banco, no una cadena de display sujeta al ancho de una
columna.

**Pero el código nunca gana por silencio:**

1. **Código catalogado** → gana.
2. **Código presente y no catalogado** → **no** se cae al texto en silencio. Se permite la vía de texto y el
   resultado queda marcado `texto_con_codigo_no_catalogado`: un estado **nombrado y contable**, con un test que
   falla si su cantidad crece sin que crezca la lista de códigos. Misma disciplina que `no_verificable`.
3. **Las dos vías resuelven y DISCREPAN** → **nunca se elige una**. `sin_reconocer`, motivo
   `evidencia_contradictoria`, con los dos candidatos. **Es el detector más valioso del motor y el único que
   funciona sin dataset etiquetado** (§8). Dejar que el código pise al texto en silencio lo destruiría.
4. **`conceptoOrigenDato === 'ninguno'`** (el Excel no llegó, o el cliente entregó en papel) → las reglas que
   dependen del código **degradan a decisión humana**, nunca al matcheo por texto.

### 2.1. La confianza **es** la vía

Sin score. Unión cerrada y ordenada:

```ts
export const VIAS_EVIDENCIA = [
  'codigo_y_texto_concordantes',    // dos evidencias independientes, mismo resultado
  'codigo_concepto',                // el banco lo dijo con su clave
  'texto_literal_exacto',           // literal completo, enumerado
  'texto_prefijo_unico',            // truncado: prefijo de UN solo literal
  'texto_prefijo_con_cola',         // patrón con cola variable declarada
  'texto_con_codigo_no_catalogado', // el banco trajo un código que no conocemos
] as const;
```

Por qué esto y no un `0..1`:

- Un score es un número que **nadie puede discutir** y que todos terminan tuneando hasta que el caso de ayer
  pasa. Una vía tiene un nombre: *"¿por qué esta propuesta vale menos?"* se responde **en palabras** que la
  contadora puede aceptar o rechazar.
- El umbral deja de ser un número: es una política por cliente, `viasQueProponen: Set<ViaEvidencia>`.
- Es **ortogonal** a los tipos que no proponen nunca (6, 10, 11): esos no proponen con ninguna vía.

**Y la diferencia entre bancos se declara, no se infiere.** Bancor publica
`CONCEPTO/EMPRESA - N° DE OPERACIÓN` en **una sola columna** —concepto, contraparte y número fusionados—, así que
ahí `texto_prefijo_con_cola` es la única vía posible. Se extiende `CapacidadesAdaptador`:
`conceptoEsCampoPropio`, `conceptoTruncadoEn`, `conceptoOrigenDato`.

---

## 3. El texto libre sin volverse un pantano de regex

> **Regla dura: el motor no contiene ni una regex escrita a mano sobre la glosa. Cero `includes`, cero
> `startsWith` sueltos.**

El banco publica un vocabulario **finito** (32 literales medidos). El matcher primario es un **diccionario sobre
un conjunto cerrado y enumerado**, no un reconocedor de patrones. Eso es auditable, testeable y —clave—
**enumerable**: "qué literales no conozco" es un informe, no una sorpresa.

### 3.1. Normalización

Encima de `normalizar()` de `parseo-ar.ts`:

1. Puntuación de abreviatura (`.`, `-`, `/`) → espacio, y re-colapso. Esto y solo esto une
   `IMP. DEB. LEY 25413 GRAL.` con `IMPUESTO DEB.LEY 25413`.
2. **Los dígitos se conservan.** `25413` es lo que distingue el impuesto de cualquier otra cosa.
3. **No hay stemming, ni stopwords, ni distancia de edición.** Todo eso convierte un error de clasificación en
   un misterio. Si dos literales del banco son el mismo concepto, **se enumeran los dos**.
4. Los marcadores `[CUIT]`/`[CBU]`/`[DOC]` se conservan en la forma normalizada **pero están prohibidos como
   evidencia**: ya se midió que la presencia de `[DOC]` **no prueba** que haya un documento.

### 3.2. Tres matchers, en precedencia declarada

1. **`exacta`** — igualdad de la cadena normalizada completa. Resuelve los sinónimos:
   `TRANSF A TERCEROS` y `TRANSFERENCIA A TERCEROS` son dos `literales` de **una** entrada.
2. **`prefijo_unico`** — para el truncado que no se enumeró. Se acepta **solo si** se cumplen las cuatro
   guardas: (a) es prefijo de **exactamente un** literal del léxico; (b) longitud ≥ `prefijoMinimo`; (c) el corte
   cae en **borde de token**, nunca a mitad de palabra; (d) el `ladoEsperado` del concepto **coincide con el
   lado del movimiento**. Prefijo de dos o más → `ambiguo` con los candidatos. **Nunca "el más probable".**
3. **`prefijo_con_cola`** — obligatorio para Santander y Bancor. **La cola no es evidencia de tipo**: es la
   contraparte, y va a la imputación.

### 3.3. El peligro del prefijo, resuelto mecánicamente

Que `IMP` "agarre también la devolución" no se evita con cuidado del programador:

> **PROP-3:** para todo par de literales de entradas **distintas** del mismo banco, ninguno es prefijo del otro
> cuando su longitud ≥ `prefijoMinimo`. Si el par existe, el léxico es ambiguo **por construcción** → CI rojo,
> antes de que corra un solo movimiento.

Verificado a mano sobre los tres pares de §0.A: los tres pasan bajo prefijo anclado.

---

## 4. Reversas: `polaridad` + `reversaDe`, y el invariante que las ataja

**No son un tipo aparte.** La regla 1 de la contadora las trata como el mismo tipo con signo contrario. Si
fueran tipos, harían falta hasta 14 más, la tabla de imputación se duplicaría, y se perdería lo que hace
valiosa la distinción: *una reversa imputa a la misma cuenta que su base, del otro lado*. Con `reversaDe`, la
imputación de la reversa **se deriva**.

Y tampoco es "solo el lado": el **lado es un hecho del documento**; la **polaridad es una interpretación**.
Confundirlos pierde el control cruzado, que es esto:

> **INV-M2-1 — coherencia de reversa.** Con `polaridad: 'normal'`, `lado === ladoEsperado`. Con
> `polaridad: 'reversa'`, `lado === opuesto(ladoEsperado)`. Si no se cumple → **no hay propuesta**:
> `sin_reconocer`, motivo `reversa_incoherente`.

Es el análogo exacto del `refine` de importe/columna del Módulo 1, y ataja el modo de falla que ningún ojo
humano ve: si el léxico matcheara `DEV.IMP.CRED.LEY 25413` como el impuesto normal (`ladoEsperado: 'debito'`),
el movimiento es un **crédito** → el invariante lo rechaza. **El error de mapeo se detecta por aritmética de
lados, sin que nadie etiquete nada.**

**Lo que el motor NO hace con una reversa:** no la empareja con su original ni netea. Aparearlas es criterio
—puede caer en otro período— y netear destruye la trazabilidad uno-a-uno.

---

## 5. Lo que el motor no puede decidir: tres clases, no un flag

```ts
export type Reconocimiento =
  | { clase: 'propuesta';       tipo; concepto; polaridad; lado; via; evidencia; … }
  | { clase: 'decision_humana'; tipo; concepto; polaridad; lado; via; evidencia; queDecide; … }
  | { clase: 'sin_reconocer';   motivo; candidatos; evidencia };
```

**Tres clases, no dos más un booleano**, porque son **tres trabajos distintos** para la persona: en
`decision_humana` el motor **ya sabe qué es** y la persona elige una cuenta; en `sin_reconocer` la persona tiene
que decir **qué es**. Un solo estado "pendiente" mezcla los dos y la cola se vuelve inutilizable.

`queDecide` es una unión cerrada: `elegir_cuenta_de_pasivo_del_impuesto` (regla 6) ·
`confirmar_cuenta_propia_destino` (10) · `distinguir_tercero_de_socio` (12, 13) ·
`completar_con_liquidacion_del_adquirente` (11) · `confirmar_computo_de_credito_fiscal` (3).

`MotivoSinReconocer`: `concepto_no_catalogado` · **`concepto_sin_tipo_asignado`** (§0.C: hueco de producto) ·
`codigo_no_catalogado` · `evidencia_contradictoria` · `ambiguo` · `reversa_incoherente` ·
`sin_evidencia_de_concepto`.

### 5.1. La garantía es el compilador **y** la base

En TS: la función que arma el asiento toma el tipo estrechado, así que **no compila** con las otras dos clases.

En la base, con el idiom que el repo ya usa (la FK de tres columnas):

```sql
  clase        text not null check (clase in ('propuesta','decision_humana','sin_reconocer')),
  es_propuesta boolean generated always as (clase = 'propuesta') stored,
  constraint uq_recon_propuesta unique (cliente_id, id, es_propuesta),

-- en asiento_propuesto:
  reconocimiento_es_propuesta boolean not null default true check (reconocimiento_es_propuesta),
  constraint fk_asiento_recon foreign key (cliente_id, reconocimiento_id, reconocimiento_es_propuesta)
    references reconocimiento_movimiento (cliente_id, id, es_propuesta)
```

Con eso **un pendiente con un asiento colgado es imposible en la base** — incluso bajo `BYPASSRLS`, `COPY` o un
bug de la app.

### 5.2. Idempotencia, y el trabajo del contador no se descarta

- Reprocesar con la **misma** versión de léxico es no-op.
- Con una versión nueva: reconocimiento nuevo, el viejo queda `superseded_por`. **Nunca se borra.**
- 🔴 **Un reconocimiento con decisión humana registrada no se recalcula solo**: se marca
  `recalculo_disponible` y la persona opta. Si no, un arreglo del léxico **descarta en silencio el trabajo de
  la contadora**.

---

## 6. La evidencia guarda ids del léxico, nunca el texto

La decisión que hace que esto no sea un canal de fuga: **la evidencia no guarda el texto que matcheó; guarda el
`id` de la entrada del léxico.** El léxico es N0 y es código, así que pintarla en pantalla es un join contra
código. **Ninguna fila de evidencia contiene un dato del cliente.**

| Nunca | Por qué |
|---|---|
| La `descripcion` copiada | Es N2 y ya está en el movimiento. Duplicarla arrastra N2 a una tabla que existe para listarse barato — H-8 otra vez |
| Un CUIT, DNI, CBU o su fragmento | Son N2-R. La comparación va **por hmac** y se guarda el **veredicto** (`coincide_socio`) |
| El **valor** de una referencia | El tipo (`factura`, `vep`, `comercio`) alcanza para explicar |
| Los marcadores `[DOC]`/`[CUIT]` como evidencia | La presencia del marcador **no prueba** que haya un documento: lo produce igual un número de operación |
| La cola de un `prefijo_con_cola` | Es el nombre de la contraparte |

---

## 7. Aprender sin volverse un oráculo (H-6)

| Nivel | Dónde | Alcance | Quién escribe | Riesgo H-6 |
|---|---|---|---|---|
| **Léxico del banco** | `lexico/<banco>.ts` — **código** | compartido, N0 | un PR revisado | **nulo: no hay escritura en runtime** |
| **Regla del cliente** | tabla N2 con `cliente_id`, RLS forzada | un cliente | el contador de ese cliente | nulo por construcción |
| **Observación** | tabla N2 con `cliente_id` | un cliente | el motor | nulo; la promoción es humana |

> **El motor nunca escribe en el léxico. No existe una tabla compartida escribible.** Eso cierra H-6 en la raíz,
> no con un `where cliente_id = ?` que alguien se puede olvidar.

**Y la trampa que hay que declarar: no existe agregación cross-cliente, ni para el informe de promoción.**
"Este literal aparece en 6 clientes" es un agregado sobre datos de varios clientes, y agregar **no
desclasifica** (ADR-0002 §A.2.3: baja de nivel solo con k≥20 registros de ≥5 clientes y decisión registrada del
titular). El informe se lee **por cliente**. Es más lento y es la única versión defendible.

**Tests que lo fijan:** INV-9 (crear una regla en A; como usuario de B, un movimiento idéntico → `sin_reconocer`,
**no** la respuesta de A) · toda tabla del motor tiene `cliente_id`, con whitelist **vacía** · `nucleo/` y
`lexico/` no importan `packages/data` — *un léxico que pueda leer la base es un léxico que puede aprender solo*.

---

## 8. Verificar que el motor no empeoró, sin dataset etiquetado

**8.1. Propiedades sobre la TABLA, no casos.** Crecen gratis con cada banco: PROP-1 cada concepto mapea a
exactamente un `(tipo, polaridad, ladoEsperado)` · PROP-2 ningún literal en dos entradas · **PROP-3** ningún
literal es prefijo de otro (§3.3) · PROP-4 toda reversa apunta a un concepto con `ladoEsperado` **opuesto** ·
**PROP-5** todo tipo tiene ≥1 entrada **o** una declaración `sinEvidenciaEnElRoster` con motivo (hoy: los cuatro
de §0.B) · PROP-6 toda entrada tiene `procedencia`.

**8.2. El corpus es el VOCABULARIO, no los movimientos.** No hay movimientos etiquetados y **no hacen falta**:
lo que hay que etiquetar son los **32 literales** de Galicia y los de Santander, que son **N0** — son las
etiquetas que imprime el banco, no datos de sus clientes. **Lo etiqueta la contadora, una vez.**

**8.3. Mutación del léxico** (espejo de las mutaciones del Módulo 1): borrar una entrada, fusionar dos,
**invertir un `ladoEsperado`**, acortar un literal. Cada una tiene que poner rojo un test **nombrado**; si
alguna no la ataja nadie, es un agujero declarado.

**8.4. La matriz de regresión** — la respuesta directa a "arregla uno y rompe cinco". Se commitea el informe de
cobertura por banco × tipo × vía, y el test afirma `regresiones === 0`: **las mejoras pasan, las regresiones
ponen rojo**. No compara salidas contra sí mismas (eso es el anti-patrón del snapshot): compara contra la
expectativa etiquetada.

**8.5. Los dos detectores que funcionan SIN etiquetas, sobre datos reales.**

- **Contradicción código↔texto.** Galicia trae las dos vías: la discrepancia es una señal **auto-etiquetada**.
- 🔴 **El anexo del banco es un set etiquetado POR EL BANCO, para dos de los 14 tipos.** El bloque posterior a
  `Total` publica `TOTAL RETENCION IMPUESTO LEY 25.413 SOBRE DEBITOS` / `SOBRE CREDITOS` y
  `TOTAL IMPUESTO I.V.A. SOBRE DEBITOS`. Entonces:

  ```
  Σ importes reconocidos como imp_25413_sobre_debitos  ==  anexo.SOBRE_DEBITOS
  Σ importes reconocidos como iva_sobre_gasto_bancario ==  anexo.IVA_SOBRE_DEBITOS
  ```

  Si no coincide, **o hay un movimiento mal clasificado o falta uno** — y lo dijo el banco, no nosotros. Es la
  verificación más fuerte disponible y no requiere ni una etiqueta humana.

  **Dos cuidados:** el anexo cubre **tres períodos distintos**, así que el cruce corre **solo** sobre la fila
  cuyo período iguala al de la cuenta y las otras son `no_verificable`; y **exige la tabla de anexos, que hoy no
  existe**.

---

## 9. Lo que falta capturar en el Módulo 1 (además de lo de `04` §9)

| Prio | Falta | Por qué el motor no funciona sin él |
|---|---|---|
| 🔴 | **`conceptoBanco` persistido**, separado de la contraparte | Es la **clave de entrada al léxico**. El esquema Zod lo tiene y **la migración `0004` no lo persiste**: solo hay `descripcion` y `concepto_codigo`. Si el concepto llega pegado a la contraparte, **todo** match degrada a `prefijo_con_cola` |
| 🔴 | **`conceptoCompleto: boolean`** | Distingue "literal corto" de "literal **truncado**". Caso medido y crítico: **`ACREDITAMIENTO` son 78 movimientos** —el concepto más frecuente del extracto— y con 14 caracteres **no se puede saber si está completo**. Sin este campo el matcher de prefijo adivina. **No es reconstruible**: el ancho de la columna es un hecho del parseo |
| 🔴 | `conceptoGrupoCodigo` + literal publicado del código + `conceptoOrigenDato` | Sin grupo ni literal el código no se audita; sin el origen, "no hay código" y "el código vino vacío" se ven igual |
| 🔴 | `contraparteDocumentoTipo` + `contraparteDocumentoHmac` | Precondición de las reglas 12/13 y de la allowlist de organismos |
| 🔴 | **`contraparteCbuHmac`** | Regla 10. Una transferencia entre cuentas propias tiene el **mismo CUIT de los dos lados**: el documento dice "es propia" y **no dice cuál cuenta**. El CBU es el que la identifica |
| 🔴 | `referencias[]` con tipos cerrados, persistidas | `factura` empareja la comisión con su IVA; `comercio`/`terminal` es el join con el adquirente; `vep` identifica el pago |
| 🔴 | **Tabla de `anexos`** | Habilita el detector sin etiquetas de §8.5 |
| 🟡 | `conceptoLineas: [inicio, fin]` | Evita leer el nombre de la contraparte como concepto. El adaptador lo sabe geométricamente |

---

## 10. Decisiones abiertas — para el titular o la contadora

| Prio | Pregunta | Por qué no la decide el equipo técnico |
|---|---|---|
| 🔴 | **¿Qué es `ACREDITAMIENTO`?** **78 movimientos**, el concepto más frecuente del extracto. Si es acreditación de adquirente —y en el mismo vocabulario está `ANULAC. ACRED. FIRSTDATA.`—, entonces **78 movimientos van a `decision_humana`** por falta de la liquidación. Si es otra cosa, cambia todo el volumen del piloto | Es criterio sobre el vocabulario de su banco |
| 🔴 | **Los 14 tipos no cubren el material** (§0.C): FCI, percepción de IVA y compra con débito, **31 movimientos**. ¿Se agregan tipos o quedan como `concepto_sin_tipo_asignado`? | El catálogo de tipos es de la contadora |
| 🔴 | **Etiquetar el corpus de vocabulario**: 32 literales de Galicia + los de Santander, `literal → (tipo, polaridad)`. Es el único insumo humano que el motor necesita para ser verificable, **y no son datos de sus clientes** | Es la etiqueta de referencia |
| 🟡 | `PAGO DE SERVICIOS` y `DEB. AUTOM. DE SERV.` (8 mov.): ¿tipo 12 o gasto propio? | Criterio |
| 🟡 | Política `viasQueProponen` por cliente: ¿`prefijo_con_cola` propone o deriva a persona? | Es su tolerancia al error |
| 🟡 | Bancor tiene concepto, contraparte y número **fusionados en una columna**: ¿se acepta que todo ese banco resuelva por `prefijo_con_cola`, o arranca en `decision_humana`? | Decisión de producto |

---

_**Validar con profesional matriculado.** Que el IVA sobre comisiones sea crédito fiscal computable, que la
retención SIRCREB sea computable en su fisco, y la porción computable del impuesto a los débitos y créditos:
**no tengo esa fuente cargada**. Por eso el tipo 3 deja `confirmar_computo_de_credito_fiscal` como decisión de
una persona y el motor **no cablea** "IVA → crédito fiscal"._

_Las decisiones 🔴 de §10 son precondición: **sin el corpus etiquetado y sin saber qué es `ACREDITAMIENTO`, el
motor se puede escribir pero no se puede verificar.**_
