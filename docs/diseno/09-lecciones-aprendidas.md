# Lecciones aprendidas de los tres primeros bancos — y cómo hacer el cuarto

> **Para qué existe este documento.** Faltan **cinco bancos** del roster (Bancor, Nación, ICBC, Credicoop,
> BBVA) y los tres primeros costaron caro en errores que **se repitieron con caras distintas**. Esto no es
> una bitácora —esa es `HANDOFF.md`— sino el **procedimiento y las trampas** para que el cuarto no vuelva a
> pagarlos.
>
> Léase **antes** de escribir un adaptador nuevo, junto con la spec del banco.

---

## 0. La lección que engloba a todas

> ### Todo lo que salió mal produjo un resultado que **cuadraba igual**.
>
> Ni un solo error de esta etapa se manifestó como una excepción, un total que no cerraba o un test rojo.
> Todos daban un número plausible, con la aritmética cerrando y el lote en verde.

Ese es el modo de falla del dominio, y define el método: **no alcanza con que el resultado sea coherente
consigo mismo. Tiene que ser coherente con el documento.** De ahí sale todo lo demás.

---

## 1. El error de los cuatro rostros: **el límite que no se puso**

Cuatro veces, en cuatro lugares distintos, el mismo error. Vale la pena verlos juntos porque el quinto va a
aparecer en el cuarto banco con una cara nueva:

| Dónde | El límite que faltaba | Qué producía |
|---|---|---|
| Clasificación por concepto | `includes('IDCB')` en vez de prefijo anclado | Sumaba una **extracción de efectivo** al impuesto. La conciliación del anexo pasaba de `true` a `false` |
| Vocabulario de Macro | El ancla `TRANSF: ` con **espacio final**, y el banco lo imprime pegado | **84 movimientos sin concepto**, con la glosa completa y los importes correctos |
| Lectura del CBU | `/\d{22}/` **sin `\b`** | Una corrida de 23 dígitos se recorta a 22 → **CBU plausible e inexistente**, y la cuenta nunca vuelve a resolver |
| Banda del titular | Banda de `x` **sin corte derecho** | El **documento del titular** termina guardado adentro del campo del nombre |
| Banda de la glosa | `fragmentosEnBanda` con `hasta` **inclusivo** | Las 1221 referencias adentro de la descripción |

**La regla:** todo patrón que localiza un dato necesita sus **dos** límites explícitos — de texto (`^`, `\b`,
prefijo anclado) o de geometría (`desde` **y** `hasta`). Un límite abierto no falla: **captura de más, en
silencio**.

Y el corolario que duele: **los cuatro campos afectados no se imprimen nunca** (por diseño de seguridad), así
que un valor sucio ahí es invisible para siempre. El único momento en que se puede detectar es al escribirlo.

---

## 2. Un fixture escrito desde la especificación **no la verifica: la consagra**

Es la lección más cara de la etapa, y la que más se va a repetir.

**El caso.** `07` §2 declaraba que el CUIT venía con la razón social **pegada**. Era falso. La cadena:

```
la spec lo dice mal
  → el adaptador se escribe contra la spec
    → el FIXTURE DEL TEST también se escribe contra la spec
      → 64 tests verdes confirmando el mismo supuesto falso
```

**Ninguna de las tres capas puede detectarlo, porque las tres derivan del mismo origen.** Lo único que lo
rompió fue mirar la forma del documento real.

### Por qué ese renglón sobrevivió, y la regla que deja

Era **el único renglón de la tabla de §2 sin una regex verificada en §2.1**. Todos los demás tenían su patrón
contado contra el archivo (`→ 45`, `→ 47`, `→ 3`); ése se había descrito a ojo.

> 🔴 **Un renglón de especificación sin conteo verificado es un renglón NO MEDIDO.** Marcarlo como tal, y
> tratarlo como hipótesis hasta que tenga su número.

### Los otros dos casos del mismo tipo, para que se vea que no fue mala suerte

- **Coordenadas redondeadas.** Los primeros tests de `fragmentosEnBanda` usaban `263.5` en vez del `264.0`
  medido, así que **el borde nunca se ejercitaba** — y el borde estaba mal. Un fixture que usa valores
  "cómodos" en vez de los publicados no prueba el caso real.
- **Filas de un solo fragmento.** El fixture del titular armaba la fila con **un** fragmento; en una carátula
  real tiene tres. Todo patrón anclado con `^` pasaba en el test y fallaba en el archivo.

### La contramedida: **probar por mutación**

Un fixture sirve **solo si se cae cuando la premisa cambia**. La forma de saberlo es revertir el lector a la
versión equivocada y contar cuántos tests caen:

| Mutación aplicada al lector | Tests que caen |
|---|---|
| El ancla original con `^` | 2 |
| Exigir razón social pegada (lo que decía la spec) | 5 |
| Leer del texto de la fila en vez del fragmento | 4 |
| **Banda sin corte derecho** (el CUIT entra en el nombre) | **4** |
| Ventana sin límite de interlineado | 1 |

**Si una mutación no rompe ningún test, ese test no está probando lo que dice probar.**

---

## 3. El destino de una línea es **QUÉ ES**, no **DÓNDE ESTÁ**

Los tres adaptadores reportaban el residuo con semánticas distintas, y **el que mejor puntuaba era el que más
perdía**:

| Banco | `lineasNoInterpretadas` | Anexos capturados | Qué pasaba |
|---|---|---|---|
| Galicia | 47 | 0 de 9 | Sus 9 renglones estaban **en el residuo**: se veían |
| Macro | 141 | 3 de 6 | Los otros 3 estaban en las reglas de ruido: **descartados sin rastro** |
| **Santander** | **0** | **0 de 7** | **No estaban en ningún lado** |

Santander sacaba 0 porque su adaptador decidía que *"lo que cae fuera de la región de tabla no se reporta"*.
**"Fuera de la región" es una ubicación, no un destino.**

### La forma correcta, ya implementada en un banco

Una **unión cerrada de destinos**, donde toda fila tiene exactamente uno y **`sinDestino` tiene que dar 0**:

```
movimiento 158 · continuacion 98 · saldoDeclarado 4 · ruido 38 · anexo 7
  · fueraDelCuerpo 7 · residuo 0 · sinDestino 0
```

Con dos separaciones que importan:
- **`fueraDelCuerpo` se cuenta y no pone el lote en rojo; `residuo` sí.** Son cosas distintas.
- Y el lector que produce el recuento **es el mismo** que produce el resultado (`leerX` delega en
  `leerXConDestinos`), para que **no haya dos clasificaciones que puedan divergir**.

### La trampa más fina, medida en Galicia

Su residuo incluye el **número de cuenta** y el **CBU** — dos filas cuyo dato **sí se lee**. Porque el residuo
es *"lo que el autómata del cuerpo no consumió"*, no *"lo que nadie leyó"*: la carátula la lee otra pasada.

> **El conteo del residuo no es comparable entre bancos hasta que todos declaren destinos.** Hoy no sirve
> como gate.

---

## 4. Los controles que solo existen si alguien los escribe

Cada uno de estos nació de un caso donde **todo lo demás cerraba**:

| Control | Qué ve que nadie más ve |
|---|---|
| **INV-multicuenta** (consolidado por moneda == Σ saldos finales) | Que se **mezclaron** dos cuentas. Mezclar las tres de Macro da **1 ruptura sobre 1346 = 0,07 %**: pasa cualquier umbral |
| **`EST_CUENTAS_NO_COINCIDEN`** (cuentas declaradas vs. leídas) | Que una cuenta **nunca se abrió**. Si su saldo final es `0,00` no mueve el consolidado ni rompe ninguna cadena: **desaparece con todo en verde** |
| **El reparto débito/crédito** como criterio de Done | Un parser que ponga todo en una columna da **0 rupturas** si además invierte el saldo |
| **`relacionConMovimientos`** en el anexo | Que el importe del anexo **ya está** en el cuerpo. Sumarlo cuenta el impuesto dos veces **y el asiento cuadra** |
| **INV-14** (`conceptoBanco` prefijo de `descripcion`, con `check` en la base) | Que el concepto se cortó de un texto **sin depurar**, metiendo el identificador de un tercero en una columna N2 |

**El patrón común:** el control tiene que compararse contra algo que **el documento declara** y que el
adaptador **no produjo**. Un número que el propio adaptador calcula no verifica nada — es el autocertificado
que el contrato prohíbe. Por eso `cuentasDeclaradas` se cuenta desde un **literal distinto** del que se usó
para sectorizar.

---

## 5. Método: **predicciones falsables** en vez de conjeturas

Dos veces en esta etapa hubo que decidir sobre algo que no se podía ver. Las dos se resolvieron igual: en vez
de adivinar, se escribió una **tabla donde cada hipótesis mueve los números de forma distinta**.

| Próxima corrida | Qué significaría |
|---|---|
| `anexos=9`, residuo `4` | El importe estaba en la fila del rótulo, tapado por otro fragmento |
| `anexos=7`, residuo `6` | Esas filas no llevan importe → **la spec necesita la aclaración, no el código** |
| `anexos=7`, residuo `5` | Ídem, y además se disparó la cola del período |
| `anexos=9`, residuo `3` | Las dos cosas |

Salió `7`/`5`, y se confirmó viendo **qué forma desapareció** del residuo. Una ambigüedad de documentación
resuelta **por medición y sin abrir el archivo**.

> **Antes de tocar código para resolver una duda, escribí qué número la contestaría.** Si no hay ninguno, la
> duda no está bien planteada.

Y su contracara, igual de importante: **una hipótesis mía se falsificó midiéndola.** Conjeturé que los 160
conceptos faltantes de Macro eran las 160 filas de un solo fragmento de glosa; el cruce de conjuntos dio
**0 de 160**. La causa real era otra. Medir costó menos que discutirlo.

---

## 6. Las herramientas, y qué contesta cada una

### `pnpm probar --banco <codigo> --archivo <pdf>`

Corre el adaptador contra el archivo real. **No toca la base ni el almacenamiento.** Imprime conteos, códigos
y estados — **ni un importe, ni una glosa, ni un identificador**, así que la salida se pega en un ticket sin
pensarlo.

Pasa por `resolverAdaptador`, el **mismo camino del CLI**, así que verifica de yapa tres cosas: que
`reconoce()` enganche, que **ningún otro adaptador reconozca el mismo archivo** (devolvería `ambiguo`, y eso
es un hallazgo), y que el banco declarado coincida con el detectado.

### `--caratula <n>` — la lente que destrabó todo

Imprime las primeras `n` filas **fragmento por fragmento**, con la `x` de cada uno y su **forma** (dígitos a
`9`, mayúsculas a `A`, minúsculas a `a`).

**Por qué por fragmento y no por fila:** `textoDeFila` une todos los fragmentos con un espacio, así que un
rótulo y la columna vecina que comparte baseline **se ven idénticos** a un solo texto largo. Esa diferencia es
exactamente la que decide si un lector que corta *"todo lo que sigue a la etiqueta"* se lleva puesta la
columna de al lado.

Con esta lente se resolvieron, en una corrida cada uno: el **anexo perdido** de Galicia (9 renglones), la
ubicación de su **CBU**, y el **error de la spec** del titular de Macro.

### Las **formas** del residuo

Agrupadas por frecuencia. Un encabezado que aparece 45 veces es **un** renglón, no cuarenta y cinco. Es lo
que convierte *"141 líneas sin interpretar"* en *"seis bloques conocidos"*.

---

## 7. 🔴 Procedimiento para el próximo banco

### Antes de escribir una línea

1. **Leé la spec del banco entera** y marcá **qué renglones tienen conteo verificado y cuáles no**. Los que no
   lo tienen son **hipótesis**, no datos (lección §2).
2. **Corré `--caratula 20`** contra el archivo y compará la forma real con lo que dice la spec. Si difieren,
   **la spec está mal** y hay que corregirla antes de codear.
3. **Declará las capacidades** del banco con su sección de referencia: `traeSignoEnElImporte`,
   `traeTotalesDeclarados`, `multiCuenta`, `traeConsolidadoPorMoneda`, `traeMovimientosFueraDelPeriodo`. Cada
   una decide qué controles se pueden exigir.

### Al escribir el adaptador

4. **Todo patrón con sus dos límites** (lección §1). Ningún `includes`, ningún `\d{n}` sin `\b`, ninguna banda
   sin `hasta`.
5. **Unión cerrada de destinos, `sinDestino = 0`** (lección §3). El lector del recuento **es** el lector del
   resultado.
6. **Ante la duda, ausente.** *"Cuando falta el peldaño mínimo de evidencia → `indeterminado`, nunca el
   peldaño siguiente en silencio."* No inventar la cuenta de un anexo, ni el período, ni el corte de un
   concepto.
7. **Nada que sea producto del parseo entra en `hashFila`.** Ni `filaNumero`, ni `conceptoBanco`. Si entra, un
   reproceso con otra versión del adaptador **duplica el lote entero en silencio**.

### Los tests

8. **Fixtures con las coordenadas LITERALES de la spec**, no redondeadas, y con la **estructura real de las
   filas** (varios fragmentos, columnas vecinas compartiendo baseline).
9. **Probá por mutación** (lección §2): revertí cada premisa y contá los tests que caen. Si alguna no rompe
   nada, ese test no prueba lo que dice.
10. **Ni un valor del material real.** Escaleras, repdígitos, CUIT y CBU con **verificador inválido a
    propósito** — un identificador sintético con verificador válido **puede pertenecerle a alguien**.

### El "Done"

11. **Nunca es `estado === 'cuadra'`.** Es la lista de conteos de la spec: cuentas, movimientos **por cuenta**,
    reparto débito/crédito, saldos negativos, referencias, fechas distintas, conceptos distintos, distribución
    de líneas de glosa, rupturas por cuenta, y los controles de lote.
12. **Corré `pnpm probar` contra el archivo real** y compará **cada** número. Que el gate esté verde no
    alcanza: en esta etapa el gate estuvo verde con seis bloqueantes adentro.

---

## 8. Los niveles de prueba que existen — y no estaban escritos

Hasta hoy la taxonomía no estaba en ningún documento. **Son tres, y el tercero es el que encuentra los
errores caros:**

| Nivel | Qué prueba | Dónde | Cuándo corre |
|---|---|---|---|
| **Unitario** | Funciones puras: parseo, geometría, toolkit, verificación, adaptadores con fixtures | 14 archivos sin base | `pnpm test`, siempre |
| **Integración** | Contra **Postgres real**, con RLS forzada y las tres credenciales: aislamiento, persistencia, INV-6, catálogo | 9 archivos con base | `pnpm test`, siempre |
| **Funcional / aceptación** | El adaptador contra **el archivo real**, con los conteos de la spec como criterio | `pnpm probar` | **A mano**, porque el gate no puede abrir `privado/` |

🔴 **El tercero no está automatizado y no puede estarlo**: el gate no tiene acceso al material real (ADR-0002).
Eso lo vuelve un **paso manual obligatorio del DoD de cada banco**, no algo opcional — y es literalmente el
nivel que encontró el anexo perdido, el error de la spec, los 84 conceptos y el CBU sin leer.

**Y lo que falta**: los tres niveles conviven sin nombre en el repo. Nombrarlos —aunque sea con un prefijo en
el archivo o una etiqueta— haría visible cuál falta cuando se agrega una pieza.

---

## 9. Lo que este proyecto NO tiene, y conviene decidir antes del cuarto banco

Verificado sobre el repo, no supuesto:

| | Estado | Por qué importa ahora |
|---|---|---|
| **Backlog de historias de usuario** | ❌ No existe | Con cinco bancos por delante, cada uno se re-improvisa. La §7 de este documento es el sustituto mínimo: **una checklist repetible por banco** |
| **Criterios de aceptación** | ✅ Existen y son buenos | El "Done" por banco de `08` §3 es una lista de conteos exactos — mejor que una US típica. Pero está por **etapa de ingeniería**, no por unidad de trabajo |
| **Plan de testing declarado** | ❌ No existía | §8 lo escribe por primera vez |
| **DoD** | 🟡 Parcial | `docs/devops/03` §2 tiene el checklist pre-merge. **Le falta el nivel funcional** de §8 |

**Recomendación:** no hace falta un backlog formal para cinco bancos. Hace falta que **§7 de este documento
sea el DoD de cada uno**, y que el paso 12 —correr contra el archivo real y comparar cada número— sea
**bloqueante**. Eso captura el 90 % del valor de una US con el 10 % de la ceremonia.

---

## 10. Deuda abierta que hereda el cuarto banco

Ninguna bloquea, todas están en `08` §3 con detalle:

1. **`fragmentoEnVentanaDerecha` devuelve el primero de la ventana, parsee o no.** Un rótulo largo **tapa** al
   importe que viene atrás. Ya tiene síntoma medido en un banco.
2. **El residuo no es comparable entre adaptadores** hasta que los tres declaren destinos (§3).
3. **El gate de verificadores no mira los archivos de test.** Medido: 61 identificadores, 0 con verificador
   válido — pero eso es mérito de quien los escribió, no del control.
4. **`alta-cuenta.ts` sin tests**, siendo el que fija contra qué resuelven todos los extractos futuros.
5. **E1.1 en 5 de 14**: los otros nueve puntos del panel siguen abiertos.
6. **`inferirCortes` / `cortarEnColumnas`**: cero usuarios en tres bancos. **Se borran al confirmarlo con el
   cuarto** — borrar sobre tres es una conclusión, borrar sobre uno era una corazonada.
