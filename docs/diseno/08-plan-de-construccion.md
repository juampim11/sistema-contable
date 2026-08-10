# Plan de construcción — punto de partida tras el análisis de tres bancos

> **Para qué existe este documento.** Es el punto de entrada para retomar el trabajo **sin el contexto de la
> conversación que lo produjo**. Dice qué está hecho, qué está decidido, qué está abierto, y en qué orden
> construir. Si algo no está acá o en los documentos que referencia, **no existe**.
>
> Léase después de `HANDOFF.md` (entrada más reciente).
>
> 🔴 **Y antes de escribir el adaptador del cuarto banco, leé `09-lecciones-aprendidas.md`.** Los tres
> primeros costaron caro en errores que **se repitieron con caras distintas**; ese documento tiene el
> procedimiento (§7), las trampas medidas y los tres niveles de prueba (§8) que hasta hoy no estaban
> escritos en ningún lado.

---

## 1. La arquitectura, decidida

El corte, en cuatro capas. **La línea entre 2 y 3 es la decisión central del proyecto.**

```
POR BANCO   │  1. Extracción y parseo del PDF          adaptadores/galicia.ts, santander.ts, macro.ts
            │     → filas verificadas contra la aritmética del propio documento
            ├──────────────── se persiste el extracto (Módulo 1 termina acá) ────────────────
POR BANCO   │  2. Léxico: el TEXTO del banco → concepto canónico
            │     lexico/galicia.ts, lexico/santander.ts, lexico/macro.ts        ← DATOS, no lógica
ÚNICO       │  3. Catálogo: concepto canónico → tipo de movimiento
ÚNICO       │  4. Imputación: (tipo, columnaOrigen) → cuenta del plan del cliente
```

**Por qué la 1 y la 2 son por banco:** el mismo hecho contable tiene textos distintos. Medido — el impuesto a
los débitos y créditos aparece como `IMP. DEB. LEY 25413 GRAL.` **y** `IMPUESTO DEB.LEY 25413` en Galicia,
`Impuesto ley 25.413 debito 0,6%` en Santander, `N/D DBCR 25413 S/DB TASA GRAL` en Macro. Tres bancos, cuatro
grafías, un solo hecho. Y las grafías difieren hasta en la capitalización: Galicia todo en mayúsculas, Santander
en sentence case.

**Por qué la 3 y la 4 son únicas:** una comisión bancaria va a "Gastos y comisiones bancarias" sea de Galicia,
de Santander o de Macro. Eso es criterio contable de la contadora, no del banco. Si la imputación fuera por
banco, **esa decisión estaría escrita ocho veces**, y el día que ella cambie una cuenta hay que cambiarla en
ocho lugares — alguna se olvida y el asiento sale con la cuenta vieja **cuadrando igual**.

En una línea: **duplicar lo que depende del banco es sano —aísla fallas—; duplicar lo que depende del criterio
de la contadora es peligroso —multiplica los lugares donde su decisión queda desactualizada.**

### 1.1. El invariante que lo hace verdad en el código

> **El motor de imputación nunca ve el nombre del banco.** Su tipo de entrada no tiene `bancoCodigo`, y el
> paquete de imputación no puede importar nada de `adaptadores/`.

Sin ese test, en tres bancos aparece un `if (banco === 'galicia')` en la imputación y la separación existe solo
en este documento. Ya hay dos reglas de código relacionadas en `packages/data/tests/reglas-de-codigo.test.ts`:
ningún adaptador importa a otro, y ningún adaptador importa `data` ni `almacenamiento`.

### 1.2. Lo que sí es infraestructura compartida, medido en tres bancos

| Pieza | Estado |
|---|---|
| `texto-pdf.ts` — `aFilas()`, `fragmentoEnX`, `fragmentoEnVentanaDerecha`, `TOLERANCIA_FILA = 2.5` | **los tres bancos la usan sin modificación** |
| `parseo-ar.ts` — las cuatro notaciones de signo, fechas, importes | **los tres, sin modificación** |
| `verificacion/invariantes.ts` — `verificarAritmetica` | **los tres**, parametrizado por capacidades |
| `persistir.ts` — todo o nada | los tres |
| El pipeline de controles del CLI (INV-6, guard R18, auditoría, idempotencia) | **uno solo, a propósito** |
| `extraerPeriodo` del toolkit | **dos usuarios** (Galicia y Macro): sobrevive |
| `valorPorEtiqueta` del toolkit | un usuario (el alta de cuenta) |
| **`inferirCortes` / `cortarEnColumnas`** | **CERO usuarios en los tres bancos.** Ninguno tiene columnas de ancho fijo en caracteres: `pdf.js` emite un espacio por hueco. **Borrar cuando se confirme con el cuarto banco** |
| `fragmentosEnBanda` (`texto-pdf.ts`) | ✅ **escrita en E1.** Une la glosa partida en 1–4 fragmentos |
| `parDeColumnas`, `regionesDeTabla`, `periodoPorEtiquetas`, `seccionesPorClave` (toolkit) | ✅ **escritas en E1**, con 41 tests propios |
| `hashesDeCuenta` (`hash.ts`) | ✅ **escrita en E1.** Ata la `ClaveCuenta` y el ordinal a **una** cuenta |

---

## 2. Estado del código

`pnpm verificar` verde: **606 tests + 4 todo**, 23 archivos. Más los 18 invariantes SQL con las tres
credenciales. **Sin commits** — el titular commitea.

| Qué | Dónde |
|---|---|
| Módulo 1 completo, con las 12 condiciones de salida cerradas | `packages/{shared,data,ingesta,almacenamiento}`, `apps/cli` |
| **Los tres adaptadores funcionando**, cada uno con su Done cumplido (§3, E3) | `adaptadores/{galicia,santander,macro}.ts` |
| **E1 cerrado**: las 10 piezas que Macro y Santander expusieron | `texto-pdf.ts`, `adaptadores/toolkit.ts`, `hash.ts`, `verificacion/invariantes.ts`, `esquema.ts`, `persistir.ts`, `apps/cli` |
| 🔴 **E1.1 PARCIAL — 5 de 14 puntos del panel.** No está cerrado; ver §3, E1.1 | `invariantes.ts`, `esquema.ts`, `toolkit.ts`, `clasificacion-campos.ts`, `logger.ts` |
| **E2 cerrado**: Galicia con tests propios y migrado a `parDeColumnas` | `packages/ingesta/tests/galicia.test.ts` |
| **E4 acotado cerrado**: `conceptoBanco` + `conceptoCompleto` + la tabla de anexos | migraciones **0007** y **0008** |
| Migraciones **0001–0008** aplicadas y verificadas | `packages/data/migrations/` |
| Entorno del **piloto**, con base separada | `.env.piloto` (gitignoreado), `APP_ENTORNO=piloto` |

### 2.1. La corrida real que ya funciona

```
ENV_FILE=.env.piloto pnpm ingesta --cliente <uuid> --usuario <uuid> --banco galicia --archivo <pdf>
→ 326 movimientos, verificacion_estado=cuadra, filas_con_ruptura=0, estado=procesado
```

**Y la corrida que no toca la base**, que es la que produjo las mediciones de `02`, `06` y `07`:

```
pnpm probar --banco <codigo> --archivo <pdf>
```

Lee, parsea y verifica; **no abre conexión, no inserta, no escribe ningún objeto**. Imprime **conteos,
códigos y estados** —ningún importe, ninguna glosa, ningún identificador—, así que su salida se puede pegar
en un ticket o en el `HANDOFF`. Pasa por `resolverAdaptador`, o sea **el mismo camino que el CLI**: verifica
además que `reconoce()` enganche, que **ningún otro adaptador reconozca el mismo documento** (`ambiguo` es un
hallazgo) y que el banco declarado coincida con el detectado. Y corre los controles de **lote** —INV-multicuenta
y el conteo de cuentas declaradas— que por definición no se ven mirando una cuenta sola.

🔴 **Es lo que hizo que las specs cambiaran.** Los tres documentos de formato traen ahora lo que la corrida
**contradijo o amplió** respecto de lo que se había medido a mano: `02` §3.1-bis, §8.1, §10.1 y §14; `06`
§9.1, §9.2 y §10.1; `07` §8.1, §9.1, §12, §12.2 y §14.6. La regla es que **el documento refleje lo medido**,
no lo que se creía.

En la base del piloto: 326 movimientos, 326 filas crudas en la satélite, 326 hashes distintos, 14 en
descubierto, idempotencia confirmada.

🔴 **La base del piloto es `sistema_contable_piloto`, separada de la de los tests.** `pnpm test` trunca
`tenant_node` y todo lo que cuelga: compartirla habría borrado el material real y su rastro de auditoría. Hay
guard en los dos lados (`sembrar.ts` y `tests/ayuda.ts` abortan fuera de `APP_ENTORNO=local`).

### 2.2. Comandos

```
pnpm db:up | db:migrate | db:setup | db:seed      # infra (db:seed SOLO en local, con guard)
pnpm verificar                                    # typecheck + barrido + gate de fixtures + tests
pnpm barrido / barrido:aceptar                    # fuga de datos reales al repo (dos modos)
pnpm fixtures:generar / fixtures:verificar        # el fixture sintético y su gate de 7 chequeos
pnpm hooks:instalar                               # pre-commit con el barrido en modo estricto
pnpm probar        --banco … --archivo …          # corre el adaptador contra un archivo real, SIN tocar la base
pnpm alta:cuenta   --cliente … --usuario … --banco … --archivo …   # lee el CBU del PDF, no lo imprime
pnpm ingesta       --cliente … --usuario … --banco … --archivo …
```

---

## 3. Orden de construcción

### 3.0. 🔴 La regla que salió de construir los tres adaptadores

Es la más importante de todo este documento, y no estaba escrita en ninguna parte:

> ### **El destino de una línea es QUÉ ES, no DÓNDE ESTÁ.**
>
> *"Fuera de la región de tabla"* es **una ubicación, no un destino**. Toda línea del documento necesita un
> **destino declarado** —movimiento, ruido **con su regla**, anexo o residuo— y **la ecuación tiene que
> cerrar**: la suma de los destinos es la cantidad de filas geométricas, sin resto.

**La evidencia, y es contraintuitiva:** el banco que sacaba `lineasNoInterpretadas = 0` era el que **más
perdía**. Santander descartaba **en silencio los 7 renglones de sus dos anexos** (`06` §9): estaban fuera de
toda región de tabla, y "fuera de la región" se estaba usando como si fuera un destino. No salían ni en
`anexos` ni en `lineasNoInterpretadas` — **desaparecían sin dejar rastro**, con el lote en verde, la cadena
cerrada y el reparto correcto.

**Las tres consecuencias, ya en el código:**

1. **Un residuo de 0 no es una buena noticia por sí solo.** Lo es solo si además la partición cierra. Macro
   arrancó con **141 filas sin clasificar** y llevarlas a 0 no agregó tolerancia: agregó **destino** — eran
   seis bloques conocidos que el inventario de ruido no tenía (`07` §8.1).
2. **Cada adaptador enumera sus destinos posibles y marca cada fila con uno.** Santander los tiene
   explícitos —`movimiento`, `continuacion`, `saldoDeclarado`, `ruido`, `anexo`, `fueraDelCuerpo`, residuo—
   justamente porque ahí se descubrió el agujero.
3. **Una fila no puede tener dos destinos.** La que se volvió anexo no puede además reportarse como residuo,
   o el mismo renglón queda contado dos veces en dos listas que después alguien suma.

**Y el corolario para el que escriba el cuarto adaptador:** la métrica que hay que mirar no es
`lineasNoInterpretadas`, es **`filas geométricas − Σ destinos = 0`**.

### E1 — Cerrar lo que Macro y Santander expusieron ✅ **CERRADO**

Iban primero porque **son los que producen un resultado plausible y equivocado**, que es el modo de falla que
este módulo entero existe para evitar. Las 10, con **57 tests nuevos** (`multibanco.test.ts` +
`verificacion.test.ts`).

| # | Qué | Dónde quedó | Ref. |
|---|---|---|---|
| 1 | ✅ **`fragmentosEnBanda(fila, desde, hasta)`** | `texto-pdf.ts`. Selección por **borde izquierdo**: un fragmento que empieza adentro entra entero aunque se derrame (los 113 que invaden `REFERENCIA`) | `07` §13.1 |
| 2 | ✅ **`INV-multicuenta`** | `verificarConsolidadoPorMoneda` en `invariantes.ts`, `consolidadosPorMoneda` en el esquema y en `SalidaDeAdaptador`, y el rechazo `consolidado_no_cuadra` en el CLI **antes de persistir nada** | `07` §14.4-bis |
| 3 | ✅ **Dedup de secciones por número de cuenta** | `seccionesPorClave` en el toolkit: la clave repetida **reabre** la sección. Resuelve sola la trampa de orden de la p2 | `07` §14.2 |
| 4 | ✅ **`regionesDeTabla` + `dentroDeAlgunaRegion`** | Toolkit. El encabezado repetido no abre región; encabezado y cierre quedan **fuera** del cuerpo | `06` §11.3, `07` §9 |
| 5 | ✅ **`parDeColumnas()`** con `traeSignoEnElImporte` | Toolkit. Con `true` **cruza** columna y signo; con `false` lo **deriva** y un token firmado es un hallazgo. Un importe en las dos columnas es `null`, no "gana el crédito" | `06` §0, `07` §4.1 |
| 6 | ✅ **`periodoPorEtiquetas(textos, reDesde, reHasta)`** | Toolkit. **No** ordena el par: un período invertido es `null`, porque acá el rótulo dice cuál es cuál | `06` §11.10 |
| 7 | ✅ **`U$S`** en `importeACentavos` | `RE_SIMBOLO_MONEDA`, con `U\$S` **antes** de `\$`. `US$` no se agregó: no está medido | `06` §11.8 |
| 8 | ✅ **`EST_SIN_MOVIMIENTOS` es POR ARCHIVO** | `ContextoVerificacion.movimientosEnElLote` + `estadoSegunVerificacion`. La cuenta vacía legítima **se persiste** con observaciones: su saldo final es lo que INV-multicuenta necesita | `06` §11.7 |
| 9 | ✅ **Fechas fuera del período: severidad declarada** | Capacidad `traeMovimientosFueraDelPeriodo`. Baja a **observación**, no desaparece; `fechasDentroDelPeriodo` sigue diciendo la verdad | `07` §6 |
| 10 | ✅ **`hashesDeCuenta(clave, filas)`** | `hash.ts`. Ata la `ClaveCuenta` **y** el ordinal de empate a una sola cuenta: no hay forma de contar el ordinal sobre el archivo | `07` §10 |

### E1.1 — lo que el panel encontró 🔴 **PARCIAL: 5 de 14**

El panel (`code-reviewer` + `tester` + `seguridad-datos-financieros`, convocado según la matriz de
`agents/README.md`) revisó E1 con el gate en verde. Los **seis bloqueantes** se corrigieron en el momento;
la tabla de abajo es lo que quedó **después** de eso, y **no está cerrada**.

> ⚠️ **Corrección, 2026-08-10.** Esta sección estuvo marcada "✅ CERRADO — los 14 puntos" y era falso: se
> habían hecho cinco. Lo detectó `documentador` yendo a verificar contra el código en vez de contra el
> documento, que es exactamente para lo que sirve. Queda anotado porque **una tabla mal marcada es peor que
> una tabla larga**: nadie vuelve a mirar lo que dice "cerrado".

**Hechos:** el **1** (`EST_CUENTAS_NO_COINCIDEN`), el **2** (`CAMPOS_DIFERENCIA` como enum cerrado), el **4**
(`consolidado` y sus grafías en `CLAVES_SENSIBLES_EXTERNAS` y en `ClaveExternaProhibida`), el **7** (el
contrato de `seccionesPorClave`, más la composición con `regionesDeTabla` que los tres adaptadores aplican) y
**parte del 9** (la guarda `importeFrag !== saldoFrag`) y **parte del 14** (la flag `y`).

**Pendientes**, en el mismo orden de daño de la tabla: el **3** (el CLI sigue con el `logger` genérico —
verificado: `loggerAcotado` **no tiene un solo llamador** fuera de `shared`), el **5** (`hashFila` sin
`clienteId`), el **6** (`traeMovimientosFueraDelPeriodo` sin cota ni dirección), el **8**, el resto del **9**
(dos fragmentos en la misma ventana; `null` colapsa cuatro causas), el **10** (importe `0,00` en crédito), el
**11** (test de integración de `consolidado_no_cuadra`), el **12** (`aFilas` sin tests), el **13** (los
anti-patrones vivos en `verificacion.test.ts`) y el resto del **14**.

Se conserva la tabla completa —no se resume ni se borra— porque cada renglón dice **por qué** el arreglo es
necesario, y esa es la parte que no se puede reconstruir después.

⚠️ **Dos renglones que el código de hoy contradice. Se anotan, no se dan por cerrados:**

- **#3 — el CLI de ingesta sigue importando el `logger` genérico**, no `loggerAcotado`. Verificado:
  `apps/cli/src/ingestar.ts` importa `logger` y **`loggerAcotado` no tiene ningún llamador fuera de
  `shared`**. Es el mismo punto que §6.5, que también sigue abierto.
- **#4 — `consolidado` / `saldo_consolidado` siguen sin estar en `CLAVES_SENSIBLES_EXTERNAS`.** La lista sí
  incorporó los campos del Módulo 1 (`saldo_inicial`, `saldo_final`, `credito`, `debito`, `total_*`…), y el
  consolidado por moneda **no está entre ellos**, teniendo el mismo nivel N2 y la misma forma canónica que
  ningún detector del redactor tapa.

Quien retome: **confirmar contra el código antes de tacharlos**, no contra este documento.

| # | Qué | Por qué importa | Dónde |
|---|---|---|---|
| 1 | 🔴 **`EST_CUENTAS_NO_COINCIDEN`**: el adaptador reporta cuántas cuentas declara el documento y el CLI exige que coincida con las leídas | **Es el único agujero de mezcla que INV-multicuenta NO puede ver**: una cuenta con saldo final `0,00` cuya sección nunca se abre desaparece del sistema y **todo cierra**. La verificación está medida y escrita (`07` §14.2: el par `SALDO ULTIMO`/`SALDO FINAL`, 3 y 3) y no existe en el código | `esquema.ts`, `registro.ts`, CLI |
| 2 | 🔴 **`Diferencia.campo` es `z.string()` abierto** → `CAMPOS_DIFERENCIA` como enum | Es el único agujero de texto libre del objeto, y sale a tres canales: el log del CLI (que **prefiere `campo` sobre `codigo`**), `verificacion_detalle` —clasificado **N1** con la nota *"ninguna diferencia lleva un valor"*— y el stdout de `probar-galicia.ts`, que corre sobre material real. Hoy esa clasificación N1 es cierta **por convención, no por el tipo** | `esquema.ts` |
| 3 | 🔴 **El CLI de ingesta usa el `logger` genérico** teniendo `loggerAcotado` escrito | Es el proceso más cerca del extracto real. Sin él, cada campo nuevo depende de que alguien acuerde actualizar un blocklist. Ya estaba en la deuda de §6.5; el panel lo eleva | `apps/cli` |
| 4 | 🟠 **`consolidado`/`saldo_consolidado` no están en `CLAVES_SENSIBLES_EXTERNAS`** ni en `ClaveExternaProhibida` | El saldo consolidado es **N2** y viaja en forma canónica (`-98765.43`), que **ningún detector del redactor tapa** (`importe_ar` solo cubre `1.234,56`). `logger.info('x', { consolidado_ars: … })` compila y publica | `clasificacion-campos.ts`, `redactar.ts` |
| 5 | 🟠 **`hashFila` no lleva `clienteId`** en el material | El aislamiento del hash lo pone **solo** la constraint, no el hash. El día que aparezca un job "¿ya tenemos esta fila?" sin `cliente_id`, o el hash salga en un export, es un oráculo: el hash es **calculable offline** con el archivo, y responder "¿existe?" contesta *"¿este movimiento es de un cliente de este estudio?"* | `hash.ts` o HMAC con pepper al persistir |
| 6 | 🟠 **`traeMovimientosFueraDelPeriodo` no tiene cota ni dirección** | La evidencia son **4 movimientos, todos ANTERIORES** al período. La capacidad relaja el control para cualquier cantidad y en las dos direcciones. Tightening respaldado por la medición: observación solo si `fecha < periodoDesde`; posterior a `periodoHasta` sigue siendo error | `invariantes.ts` |
| 7 | 🟠 **`seccionesPorClave`: las filas de nivel archivo caen en la sección abierta** | Medido: **360 filas de carátula + 90 consolidados + 765 leyendas + 44 períodos** repartidas entre las secciones. Un adaptador que lea el período "de su sección" encuentra el **del archivo** y no lo nota — porque en el archivo medido coinciden. Fix: componer con `regionesDeTabla`, y decirlo en el contrato | `toolkit.ts` |
| 8 | 🟠 **Un encabezado que el detector no entiende es invisible**: no abre sección, no cae en `indicesSinSeccion`, no reporta nada. Sus movimientos van a la cuenta anterior | Misma mezcla del punto 1, otra puerta | `toolkit.ts` |
| 9 | 🟡 **`parDeColumnas`**: falta guarda `importeFrag !== saldoFrag`; dos fragmentos en la misma ventana eligen el primero en silencio; `null` colapsa cuatro causas distintas que `lineaNoInterpretadaSchema` sabe diferenciar | Un token leído como importe **y** como saldo da un par plausible con la mitad inventada | `toolkit.ts` |
| 10 | 🟡 **El importe `0,00` en la columna de crédito**: `parDeColumnas` devuelve `'0.00'` y el refine del esquema exige `'-0.00'` para débito → dos verdades para el mismo dato | El CLI no corre el esquema y persistiría; `probar-galicia.ts` sí y lo rechaza | `toolkit.ts` / `esquema.ts` |
| 11 | 🟡 **Test de integración de `consolidado_no_cuadra`** | El `tester` verificó que **se puede hacer hoy**, sin esperar a E3: `limpiarRegistro()` + un adaptador falso + un PDF mínimo de 654 bytes. El chequeo corre antes de INV-6, así que no hace falta ninguna cuenta en la base | `apps/cli/tests` |
| 12 | 🟡 **`aFilas` no tiene un solo test** y su `.sort()` por `x` es lo que garantiza el orden visual | Borrarlo no pone rojo nada: el helper de los tests ordena por su cuenta | `texto-pdf.ts` |
| 13 | 🟡 **Anti-patrones vivos en `verificacion.test.ts`**: `esperados.some(...)` y `toBeGreaterThan(0)` | Están **prohibidos por escrito** en `03` §2.3 (nº 6 y nº 4) | tests |
| 14 | 🟡 Menores: `.flags.replace('g','')` no saca la flag `y`; `regionesDeTabla` compila ~5900 regex; `repeticionesDeEncabezado` cuenta apariciones (47, no 46); el CLI oculta `procesado_con_observaciones` en su salida | | `toolkit.ts`, CLI |

**Lo que el panel confirmó que está bien** y no hay que tocar: `hashesDeCuenta` (el atado clave+ordinal es
correcto), `U$S` (el orden antes de `\$` y la decisión de no agregar `US$` sin medirlo), `periodoPorEtiquetas`
(las dos diferencias con `extraerPeriodo` bien razonadas), la semántica de bordes de `regionesDeTabla` (sin
anidamiento ni solapamiento posible), y que **E1 no rompe el aislamiento entre clientes ni filtra un valor a
un log hoy**.

**Lo que E1 había dejado abierto a propósito y E2 cerró:** `galicia.ts` no había migrado a `parDeColumnas`.
La lógica era la misma salvo un detalle (un token en las dos columnas: allá ganaba el crédito, acá es `null`)
y sobre el archivo real daba idéntico — pero mientras hubo dos implementaciones del mismo criterio, **la que
se corrigiera iba a ser una sola**.

### E2 — Tests del adaptador de Galicia ✅ **CERRADO**

El adaptador tiene tests propios sobre el fixture sintético, y las **cuatro mutaciones de texto** que estaban
en `it.todo` tienen sujeto. Estrategia completa y anti-patrones: `03-hallazgos-del-panel.md` §2.

**Condición de salida extra que agregó E1, cumplida:** `leerPar` migró a
`parDeColumnas(fila, COLUMNAS, { traeSignoEnElImporte: true })` y la copia se borró.

### E3 — Los adaptadores de Santander y Macro ✅ **CERRADO**

Con `06` y `07` en mano, y **los tres Done cumplidos contra los archivos reales** (`pnpm probar`, §2.1).
**El criterio de "Done" no es `estado === 'cuadra'`:**

| Banco | Done | Resultado |
|---|---|---|
| Galicia | 326 movimientos · 116/210 · 14 saldos negativos · 21 referencias · **0 rupturas** · 25 páginas declaradas · **32 conceptos** | ✅ (`02` §14, §8.1) |
| Santander | **2 cuentas** · 158 movimientos ARS · **reparto 83/75** · 0 rupturas · 0 `lineasNoInterpretadas` · **29 conceptos** · **`1→60 2→98`** | ✅ entero (`06` §10.1) |
| Macro | **3 cuentas (0/11/1335)** · 1346 movimientos · **0 rupturas por cuenta** · glosa completa (1–4 fragmentos) · **el consolidado por moneda cuadrando** | ✅ (`07`) |

Un adaptador que ponga los 158 de Santander en una sola columna produce 0 rupturas si además invierte el saldo:
**hay que exigir el reparto, no solo la cadena.**

**Las dos métricas que se agregaron al Done después de correr**, y que ninguna aritmética verifica:
`conceptos distintos` y la **distribución de líneas de glosa**. Cuidan la glosa, que es el producto; el
reparto por columna cuida los importes. Un adaptador puede clavar el reparto con las descripciones mutiladas.

**Lo que quedó abierto y NO bloquea el cierre de E3**, cada uno anotado en su spec:

- 🔴 **Macro: 76 movimientos sin `conceptoBanco`** (`PAGO<n>-LIQ COMER`). Hoy es **incapturable** sin romper
  INV-14: la depuración de INV-13 enmascara los dígitos embebidos y ninguna etiqueta estática es prefijo de
  la glosa depurada. Hacen falta etiquetas con hueco variable o un corte geométrico — `07` §12.2.
- ⏳ **Santander: la ambigüedad "seis rótulos para cinco importes"** del `Detalle impositivo`, con 6 filas de
  residuo `fila_sin_importe`, 2 de ellas con estructura de rótulo. **Pendiente de verificar contra el
  archivo**, con los dos desenlaces en `06` §9.1. Es el único lugar donde podría faltar un renglón fiscal.
- ⏳ **Galicia: el CBU está en el documento y no se lee**; y hay 4 renglones de carátula (acuerdo de
  descubierto y su tasa) para los que **`cuentaDetectada` no tiene campo** — `02` §3.1-bis.

### E4 — Los campos que son reproceso si se agregan después 🟠 **ACOTADO Y CERRADO; el resto sigue abierto**

Están en `04` §9 y `05` §9. **Para el cliente de mayor volumen puede no haber archivo al que volver: entrega en
papel.** Los dos más urgentes se cerraron, con migración propia:

- ✅ **`conceptoBanco` se persiste** — migración **0007**, con `concepto_banco_estrategia` y el `check`
  `mov_crudo_concepto_prefijo_chk` que sostiene **INV-14** (el concepto tiene que ser prefijo de la
  descripción **ya depurada**). Es lo que mantiene la columna en **N2** y la tabla fuera del régimen de
  lectura auditada. Es también lo que hace que el hueco de Macro sea un hueco declarado y no un parche.
- ✅ **`conceptoCompleto`** — el ancho de columna es un hecho del parseo y no es reconstruible después.
  Sin default: `true` por default haría indistinguible *"el concepto entró entero"* de *"nadie lo miró"*.
- ✅ **`conceptoBancoEstrategia`** y ✅ **`paginaPdf`**, en la misma 0007. El segundo es el **puntero de
  evidencia** del asiento propuesto: estaba en el esquema Zod y no se persistía.
- ✅ **La tabla de anexos** — migración **0008**, con `atribucion_cuenta`, `relacion_con_movimientos`,
  `periodo_dato` y `anexo_literal_sin_identificador_chk`. Los tres bancos emiten sus anexos: Galicia 9
  (`cuenta_unica_del_lote`, `02` §10.1), Santander 7, Macro 6 (`07` §9.1).

**Sigue abierto:** `referencias[]` tipadas extraídas **antes** de depurar la glosa,
`contraparteDocumentoHmac` **y `contraparteCbuHmac`** (este último es el que necesita la regla 10 y se había
omitido), `jurisdiccion`, `esMovimiento` + `motivoExclusion`, y `cotizacion` + `cotizacionProvista`.

### E5 — El lector de Excel y el cruce

Cuatro tecnologías detrás de la palabra "Excel": `.xlsx` (ZIP), `.xls` BIFF (OLE2), **TSV en Latin-1 renombrado**
(Santander) y HTML renombrado. `exceljs` solo lee `.xlsx`.

🔴 **La clave del cruce NO puede ser `(fecha, importe)`** — en Galicia hay 7 grupos con 19 filas repetidas. Tiene
que ser `(fecha, importe, saldo)`, único 326/326.

Y el premio: **Santander trae `Cod. Operativo` con 29 códigos para sus 29 conceptos** en su TSV. Son **dos de
cinco** bancos con código de concepto, no uno. Para Credicoop y Macro sigue sin medirse: sus `.xls` son BIFF y
hoy no hay lector.

### E6 — El motor de reconocimiento

**No arranca sin las respuestas de §5.** Diseño completo en `05-motor-de-reconocimiento.md`.

---

## 4. Decisiones tomadas, para no rediscutirlas

| Decisión | Motivo en una línea | Ref. |
|---|---|---|
| **Vista geométrica, no por líneas** | Los tres bancos la necesitan, por razones distintas: orden del stream (Galicia), signo solo en la columna (Santander, Macro) | `02` §1, `06` §0, `07` §1 |
| **`lado = columnaOrigen === 'credito' ? 'haber' : 'debe'`; la tabla guarda CUENTAS, nunca lados** | Se recorrieron las 14 reglas y no hay una excepción. Hace imposible por construcción la inversión de signo | `04` §2 |
| **Todo o nada por lote; el veredicto es el peor de sus cuentas** | Medio extracto es peor que ninguno: el asiento cierra mal y se descubre al cierre de ejercicio | `01` §6.2 |
| **El objeto se guarda ÚLTIMO** | Un `ROLLBACK` no borra un `PUT`: quedaría un PDF huérfano en un lugar del que el sistema no sabe | `03` §1.7 |
| **La escritura en tablas N2-R exige `escribirConAuditoria`** | El control es estructural, no "acordate de auditar" | `03` §1.4 |
| **El léxico es CÓDIGO, no una tabla escribible en runtime** | Una tabla compartida y escribible es H-6. Cierra el riesgo en la raíz | `05` §7 |
| **Sin agregación cross-cliente, ni para el informe de promoción** | Agregar no desclasifica (ADR-0002 §A.2.3) | `05` §7 |
| **La confianza es la VÍA, no un score** | Un score es un número que nadie puede discutir y todos terminan tuneando | `05` §2.1 |
| **Cuando falta el peldaño mínimo de evidencia → `indeterminado`, nunca el peldaño siguiente en silencio** | Es la lección del supuesto del código de concepto | `05` §2 |
| **La imputación es 1:1 con el movimiento; la agregación es de la exportación** | "Se suman" en las reglas es el papel de trabajo manual, no un criterio de registración | `04` §4 |

---

## 5. 🔴 Lo que hay que preguntarle a la contadora antes del motor

Sin esto el motor **se puede escribir pero no se puede verificar**.

1. **¿Qué es `ACREDITAMIENTO`?** **78 movimientos, todos crédito** — el concepto más frecuente del extracto de
   Galicia. Si es acreditación de adquirente —y en el mismo vocabulario está `ANULAC. ACRED. FIRSTDATA.`—
   entonces esos 78 van a decisión humana por falta de la liquidación, **y cambia todo el volumen del piloto**.
2. **Tarjetas: ¿"Deudores por ventas" o "Tarjeta de crédito a cobrar"?** Dijo las dos cosas en documentos
   distintos. Con cuenta separada el residuo del neteo queda **aislado y reconciliable**; dentro de Deudores se
   disuelve entre las cobranzas y **no se detecta nunca**.
3. **¿Sus clientes llevan circuito de valores** (cheques a pagar / en cartera)? De eso depende que las reglas
   12c, 13c y 14 estén bien o **dupliquen la cancelación**.
4. **¿Qué hacer con un SIRCREB sin jurisdicción publicada** (Santander no la publica)? Una cuenta que mezcla
   jurisdicciones **cuadra** y la rechaza el fisco.
5. **¿La agregación por concepto la necesita**, o la hacía porque tipeaba a mano? Si su sistema importa un
   renglón por movimiento, se gana trazabilidad gratis.
6. **Etiquetar el corpus de vocabulario**: los literales de Galicia (32), Santander (29) y Macro (~34),
   `literal → (tipo, polaridad)`. Es el único insumo humano que el motor necesita, **y no son datos de sus
   clientes**: son las etiquetas que imprime el banco.
   > **No se le pide en blanco: se le da PRE-COMPLETADO para que corrija.** El mapeo lo armamos nosotros
   > cruzando el vocabulario medido contra sus 14 reglas (`04` §3). La mayoría se cae sola. Convierte un
   > trabajo en media hora de revisión — y es exactamente lo que hace el producto: proponer con evidencia.

### 5.bis 🟢 El padrón se reduce a la lista de SOCIOS — decisión del titular, 2026-08-10

El padrón de terceros parecía el bloqueante de mayor volumen: **978 de 1346 movimientos de Macro (73 %) son
transferencias**, y `04` §1.1 deja escrito que reconocerlas es trivial pero la cuenta depende de **quién es el
otro lado**, cosa que ningún banco publica.

**La observación que lo achica:** en la cartera de este estudio, **el 95 % o más de las contrapartes de
transferencias van a ser clientes, no socios**. Enumerar todas es una lista enorme de CUIT distintos y no hace
falta: lo que hay que enumerar es **el complemento, que es chico y cerrado**.

> **Se le piden los CUIT de los SOCIOS de cada cliente. Nada más.** Todo lo que no está en esa lista es
> tercero, y el lado decide la cuenta: crédito → cobranza de cliente (13a), débito → pago a proveedor (12a).

Con eso, las reglas **12a, 12b, 13a y 13b pasan de régimen `R` a determinísticas**, y el 73 % del volumen se
resuelve solo. Es compatible con lo que `04` §3 ya exigía —*"el default «no es socio» **solo vale si el padrón
se consultó**"*—: el padrón existe, es corto, y consultarlo es barato.

**Dos cuidados que hay que dejar escritos:**
- La lista de socios es **por cliente y con vigencia** (un socio entra o sale). No es una constante.
- La regla 12b escribe *"CUENTA PARTICULAR SOCIO XX"*: el `XX` es **una resolución, no una constante**. Sin la
  lista, todos los retiros van al socio equivocado y el asiento cuadra igual.
7. **Los 14 tipos no cubren el material.** Medido: FCI (14 mov. en Galicia + 10 en Macro), percepción de IVA
   (6 + 5), compra con débito (11), **liquidación de procesadora de pagos (76 en Macro, su segundo concepto más
   frecuente)**, cheque en circuito cerrado (5). ¿Se agregan tipos o quedan como
   `concepto_sin_tipo_asignado`?

**Y una advertencia que corresponde llevarle aunque no la pidió:** la regla de tarjetas. Su simplificación es
sobre **la cuenta** y es legítima; el problema es el **importe** — el neto omite el arancel, su IVA y las
retenciones. Son plata, y el asiento cuadra igual. Ver `04` §5.

---

## 6. 🔴 Deuda de seguridad abierta

De `03-hallazgos-del-panel.md` §1. Lo cerrado ya está marcado ahí; esto es lo que queda:

1. **El objeto huérfano no tiene compensación.** Falta `eliminar()` en el `catch` + reconciliación de claves
   contra `lote_ingesta.archivo_clave` en el job de mantenimiento.
2. **`fila_origen` es `jsonb not null` sin forma declarada.** Falta `filaOrigenSchema` con `.strict()` validado
   antes del insert. Qué **no** puede llevar está en `03` §1.8 — sobre todo: nada que no sea de esa fila, o una
   lectura auditada de una fila entregaría el documento completo.
3. **El identificador no puede entrar por argumento del CLI**: queda en el historial de PowerShell, que está
   fuera del repo, del barrido y del `.gitignore`. El alta ya lo lee del PDF; **el resto de los comandos hay que
   revisarlos**.
4. **Escribir en `CLAUDE.md` y `AGENTS.md`: ningún agente abre `privado/extractos/`.** Hoy la regla vive en el
   ADR, y el ADR no es lo que se lee antes de abrir un archivo.
5. **El pipeline usa el `logger` genérico** teniendo `loggerAcotado` escrito. La persistencia es donde entran
   los campos nuevos: es el momento de migrar, antes de que haya veinte llamadas.
6. **Decidir R21 por escrito: no hay staging.** Recomendación: R21 se reduce a *prohibido `COPY … FROM` sobre
   tablas de dominio*. Si queda abierto, el día que 1346 filas tarden alguien crea una tabla de staging **sin
   RLS "porque es temporal"**.
7. **`knowledge/` está vacío.** Siete huecos normativos nombrados en `04` §7. Los cuatro que el Módulo 2 consume
   directo: cómputo del crédito fiscal, percepciones, régimen de recaudación bancaria provincial, y porción
   computable del impuesto a los débitos y créditos.

---

## 7. Limpieza pendiente

- ✅ **Los scripts de análisis descartables ya no están.** `packages/ingesta/scripts/` quedó con **dos**
  archivos, los dos vivos: `probar-adaptador.ts` (genérico, el de `pnpm probar`) y `probar-galicia.ts`.
- ⏳ **`probar-galicia.ts` quedó redundante con `probar-adaptador.ts`**, que hace lo mismo para cualquier
  banco y además pasa por `resolverAdaptador` (§2.1). Mientras convivan, la corrida de referencia de Galicia
  se puede hacer por dos caminos que pueden divergir. Decidir si se borra.

---

## 8. Cómo verificar que todo sigue bien, en tres comandos

```
pnpm verificar                                     # 606 tests + 4 todo, barrido + gate de fixtures
pnpm probar --banco <codigo> --archivo <pdf>       # el Done de ese banco (§3, E3). No toca la base
docker compose exec -T postgres psql -U sistema_contable -d sistema_contable_piloto \
  -c "select count(*) from movimiento_bancario_crudo;"        # → 326
```

Y los 18 invariantes SQL con las tres credenciales, cuya secuencia está en `.github/workflows/ci.yml`.
