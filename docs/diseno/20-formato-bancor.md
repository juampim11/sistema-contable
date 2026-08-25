# 20 — Formato Bancor (Banco de la Provincia de Córdoba S.A.), extracto de cuenta corriente en PDF

> Medido contra el PDF real del cliente en `privado/extractos/.../Banco Cta - Cte/Bancor/Resumen BANCOR
> 06-2026.pdf` (3 páginas, 186 filas geométricas vía `aFilas()`/`pdf.js`), con la misma disciplina que
> `02-formato-galicia.md` y `07-formato-macro.md`: **solo estructura y geometría, ningún dato real**.
> Toda medición se hizo por `formaParaLog` (dígitos y letras enmascarados) — nunca lectura cruda por
> shell (ver el incidente de sesión en `registro-incidentes.md` #12 y la nota de backlog en
> `10-deuda-declarada.md` §C).

## 0. Contexto: por qué Bancor y no BBVA

Esta ronda de trabajo iba a empezar por BBVA. **BBVA es imagen pura — 0 caracteres extraíbles**,
confirmado por dos vías independientes (`aFilas()`/`pdf.js`: 6 páginas, todas `sinTexto`; `pdftotext`:
6 bytes de salida sobre 1,1 MB). Esto ya estaba anotado en `HANDOFF.md` (2026-08-09 (4)) y el archivo en
`privado/` es el mismo (fecha 9 de agosto). Un adapter de columnas/geometría no tiene sobre qué correr.
BBVA queda **declarado como deuda con causa medida**, no como pendiente sin razón: necesita un proyecto
de OCR aparte —del mismo tamaño que el de `docs/diseno/15-ocr-liquidaciones-plan.md`, no un ajuste del
adapter de columnas— y se retoma cuando haya dueño para eso. Se pivotea a **Bancor**, que sí tiene texto
extraíble (13.330 caracteres vía `pdftotext`, family `ancho fijo` ya anticipada en
`01-modulo-1-ingesta-bancaria.md` §E9).

## 1. Reconocimiento del documento

Encabezado repetido en la parte superior de cada página (bloque alineado a la derecha, `x` variable
según página): razón social del banco, dirección, CUIT del banco (`##-########-#` con la leyenda
`Responsable Inscripto`) y sitio web. Título/condición ante IVA de la cuenta cae en la carátula, no en
este encabezado.

**Marcas de reconocimiento** (líneas 0-5 del documento, banco-genéricas, no dato de nadie):
- `Banco de la Provincia de Córdoba S.A.`
- `www.bancor.com.ar`

## 2. Carátula (una sola vez, página 1)

Bloque de razón social + domicilio del titular, seguido de la razón social repetida centrada, luego el
CUIT del titular (**11 dígitos corridos, SIN guiones** — a diferencia de Galicia/Santander que lo
publican con guiones) con la etiqueta `TITULAR` en la línea siguiente. Después: el período (`dd/mm/yyyy`
× 2), el tipo de cuenta (`PESOS`, código de paquete tipo `UNIPER.`), `BANCA DE EMPRESAS` y
`RESPONSABLE INSCRIPTO` como condición ante IVA.

Página 2 y 3 repiten el encabezado bancario Y un mini-bloque con el período (`dd/mm/yyyy` × 2) y un
código de cuenta — **no repiten la razón social del titular**: el ancla de identidad vive solo en la
página 1, igual criterio que Galicia (nunca buscarla fuera de la carátula, ver la nota de
`galicia.ts::leerTitular`).

## 3. El cuerpo — UNA fila = UN movimiento (a diferencia de Galicia)

Columnas (puntos PDF, medidas sobre el archivo real):

| Campo | `x` | Forma |
|---|---|---|
| Fecha | 88.0 | `dd/mm` — **sin año**, se resuelve contra el período de carátula, igual criterio que Macro |
| Concepto (+ referencia embebida) | 172.2 | ancho variable; mezcla literal de concepto y códigos de referencia con `.`/`-` |
| Referencia / N° de operación | 265.0 | corrida numérica de 3 a 8 dígitos |
| **Importe (SIN separar débito/crédito)** | ~370–467 (borde derecho, varía con la cantidad de dígitos) | `#.###,##`, **sin signo explícito** |
| Saldo | ~522–526 (borde derecho) | `#.###.###,##` |

**Medido, no supuesto: el importe es UNA sola columna, sin crédito/débito separados y sin signo.**
Recorridas ~140 filas de movimiento del archivo real, ninguna trae dos importes en la misma fila ni un
signo `-` en la columna de importe. Esto **confirma** —contra este archivo, no solo por el análisis de
2026-08-09— que `traeSignoEnElImporte: false` para Bancor: la asignación crédito/débito **tiene que**
derivarse de la cadena de saldos (§5).

**Y, medido: cada movimiento cierra en su propia fila.** A diferencia de Galicia (donde el par
importe/saldo llega en una fila posterior a la fecha), en Bancor la fila que trae la fecha **ya trae**
concepto + referencia + importe + saldo completos. Esto simplifica el autómata: no hace falta un estado
`EnConstruccion` que espere el par — alcanza con "una fila con fecha en `x≈88` es un movimiento
completo".

**Corrección a `01-modulo-1-ingesta-bancaria.md` §E9 y a la fila del panel de 2026-08-09**: esos
documentos anticipaban `cadenaDeSaldos: 'por_puntos_de_control'` para Bancor (saldo no en cada fila).
**Medido contra este archivo real: el saldo aparece en el 100% de las filas de movimiento revisadas**
(las ~140 filas con fecha, en las tres páginas) — así que para este archivo `cadenaDeSaldos: 'completa'`.
Se corrige la expectativa por la medición, no al revés (mismo criterio que ya aplicó Galicia con el
saldo inicial no rotulado). Si un futuro archivo de Bancor sí trajera huecos, el código debe fallar
cerrado a `no_disponible` en esa cuenta, no forzar la cadena.

## 4. Líneas de continuación (sin fecha)

Entre movimientos aparecen filas SIN fecha con un patrón `[11 dígitos] - [palabras cortas]` en la banda
del concepto (`x≈172`) — una referencia u operación asociada al movimiento anterior. **No cierran ni
abren un bloque** (a diferencia de Galicia): el movimiento en la fila de fecha ya está completo con su
importe y su saldo. Se tratan como continuación informativa que se agrega a `descripcionLineas` /
`referencias` del movimiento inmediatamente anterior — nunca se descartan en silencio, y si no hay
movimiento abierto al que atribuirlas (carátula, pie), van a `lineasNoInterpretadas`.

Algunas filas de movimiento traen, en la misma banda de concepto, un patrón `NN% *##########*` — un
porcentaje seguido de un número enmascarado entre asteriscos. Es consistente con una retención SIRCREB
(alícuota + cuenta), pero **no se confirmó el literal de etiqueta** (ver §6). Se captura como parte de
`descripcion` tal cual el banco la imprime; no se modela un campo `jurisdiccion` propio — mismo alcance
que ya tiene Macro, que declaraba esta intención en el diseño original (§E9) y **nunca la construyó**:
no se introduce ahora una asimetría entre bancos para un campo que hoy no existe en `esquema.ts`.

## 5. Derivar crédito/débito de la cadena de saldos (el mecanismo nuevo de este adapter)

Como el importe no trae signo ni columna propia, el criterio es:

```
delta = saldo(n) − saldo(n−1)          (bigint, centavos — importeCanonicoACentavos)
si delta === importe(n)                → crédito
si delta === −importe(n)               → débito
si ninguna de las dos cierra           → residuo (no se adivina; se reporta con su forma y su fila)
```

**Comparación EXACTA, sin tolerancia** (corrección de `tech-lead` sobre el primer borrador de este
documento, que proponía una tolerancia): `saldo` e `importe` ya son `bigint` en centavos — no hay float
que redondear (ADR-0000 §2.3). Una tolerancia sería el único punto del módulo donde una fila mal leída
podría colarse como "cierra igual". Si algún día aparece un caso real con una diferencia de centavos, esa
tolerancia se mide y se documenta con su causa — no se anticipa acá.

`saldo(0)` es el saldo inicial declarado en la línea `SALDO RES. ANTERIOR` (literal confirmado, banco-
genérico) que abre el cuerpo, antes del primer movimiento con fecha — mismo rol que el saldo inicial
derivado de Galicia, salvo que en Bancor **sí** viene con etiqueta explícita, así que no hace falta
derivarlo por aritmética.

Esta función es la única nueva que necesita el toolkit compartido: no existe hoy en `toolkit.ts` porque
ningún banco anterior la necesitaba (los tres publican el signo o la columna — tabla de
`traeSignoEnElImporte` en `toolkit.ts`). Vive en `bancor.ts` hasta que un segundo banco la necesite —
mismo criterio que ya siguió `seccionesPorClave` antes de subir a compartido.

🔴 **La cadena de saldos deja de ser una verificación independiente para Bancor — es la FUENTE del
signo, no una segunda señal que lo contraste** (hallazgo de `tech-lead`). En Galicia/Santander/Macro, V1
y V5 (`verificarAritmetica`) confirman una columna que el banco ya publicó por otra vía; acá, todo
movimiento emitido por `leerBancor` cumple la identidad de saldos **por construcción** — cualquier fila
que no cerrara ya quedó excluida como residuo antes de llegar a la verificación. Esto tiene que quedar
explícito en `CAPACIDADES_BANCOR` (comentario, no solo el campo `traeSignoEnElImporte: false`) para que
nadie lea `cadenaDeSaldos: 'completa'` en el catálogo y asuma una verificación cruzada real que, para
este banco, no existe — mismo estilo que ya usa `santander.ts` para documentar qué invariante no corre y
por qué.

## 6. El bloque de totales (página final, antes del pie legal) — RESUELTO, literal confirmado por JP

Después del último movimiento y antes del separador (`x=10.0`, línea `-`), la página final trae **9
líneas** con un patrón repetido: palabra `Total` a `x≈45.8` + una segunda etiqueta variable + `:` + un
importe con signo `$` (`x≈252–278`). El literal exacto de las 9 etiquetas —bloqueado inicialmente porque
el clasificador de permisos de la sesión rechazó, correctamente, una lectura cruda adicional por shell
(incidente #12 de `registro-incidentes.md`)— lo confirmó **JP mirando el documento completo**, no un
agente. Las 9, en orden de lectura:

1. `Total Impuesto al Valor Agregado`
2. `Total Imp.Ley de Competitividad`
3. `Total Imp.L.Competitiv. Credito Compensable`
4. `Total SIRCREB`
5. `Total SIRCREB CBA`
6. `Total SIRCREB C.A.B.A.`
7. `Total SIRCREB Sta. Fe.`
8. `Total Percepciones C.A.B.A.`
9. `Total Percepciones por consumos en el exterior`

Vocabulario bancario genérico (nombre de tributo o régimen de retención) — mismo criterio de
clasificación N0 que el resto del léxico de concepto (§8), no dato de cliente.

**🔴 Inconsistencia de formato real dentro del mismo bloque, confirmada por JP, no asumida.** Las líneas
con importe **≠ 0** usan el formato argentino de siempre (`$#.###,##`, coma decimal). Las líneas con
importe **= 0** usan **punto decimal** (`$0.00`), sin separador de miles — 5 de las 9, en el documento
medido. El parser tiene que aceptar las DOS formas; un patrón que solo reconozca coma decimal deja esas
5 líneas cayendo en `lineasNoInterpretadas` aunque la etiqueta matchee perfecto.

**Ahora sí se modela como `anexos[]`** (`AnexoExtracto`), con las 9 etiquetas ancladas por regex (mismo
patrón `RELACION_POR_LITERAL` que ya usa `galicia.ts`): `atribucionCuenta: 'cuenta_unica_del_lote'`
(un solo lote, una sola cuenta — spec §2), `periodoDato: 'no_publicado'` (el bloque no declara período
propio, y el sistema **nunca** rellena esto con el período del extracto). `relacionConMovimientos` es
`'resume_movimientos_del_cuerpo'` solo para las dos etiquetas con cruce implementado (§6.1); las otras
7 quedan `'no_determinada'` — fail-closed, no se afirma una relación que no se verificó. Una línea con
forma de totales (`$importe`) que NO matchee ninguna de las 9 etiquetas conocidas sigue cayendo a
`lineasNoInterpretadas` (`linea_fuera_de_zona`) — el vocabulario podría crecer en un extracto futuro.

## 6.1. Verificación cruzada opcional (dos de nueve, sugerida por JP)

No bloqueante, agregada porque es barata con el mecanismo de anexo ya construido:

- **`Total SIRCREB CBA`** contra la suma de los movimientos del cuerpo cuya glosa contiene
  `RECAU.SIRCREB CBA` (literal ya confirmado en §8).
- **`Total Impuesto al Valor Agregado`** contra la suma de los movimientos cuya glosa contiene `IVA 21%`
  y `COMISIONES` (literal indicado por JP; **no medido geométricamente por este adapter** — el match es
  por substring sobre `descripcion`, no por posición).

`verificarTotalesBancor()` en `bancor.ts` es una función pura, separada del contrato
`SalidaDeAdaptador` (no se cambia el contrato compartido para esto): compara y devuelve la diferencia si
no cierra. **Nunca fuerza a que cuadre** — mismo criterio que el resto del proyecto. No está conectada
al CLI todavía; es una utilidad para quien la necesite (queda declarado, no es deuda oculta).

## 6.1. Las tres capacidades que el catálogo (0024) declara y este documento no había medido todavía

Hallazgo de `dba-data` en la revisión de `0024_catalogo_bancor.sql`: el resumen `capacidades` de esa
migración trae `multiCuenta`, `multiMoneda` y `declaraDestinos` sin que este documento los sustentara.
Se cierra acá, antes de escribir el adapter:

- **`multiCuenta: false`** — medido: un solo bloque de carátula (una razón social, un CUIT de titular,
  un período) en las 186 filas del documento completo. Ningún encabezado de sección se repite con un
  número de cuenta distinto (a diferencia de Macro/Santander). Si un futuro extracto de Bancor trajera
  más de una cuenta, esto se corrige con la medición de ESE archivo, no se anticipa acá.
- **`multiMoneda: false`** — medido: la carátula declara `PESOS` una sola vez; ningún bloque
  `Consolidado`/`resumen por moneda` aparece en el documento.
- **`declaraDestinos: true`** — **no es un hecho de layout, es una promesa de código** (mismo criterio
  que ya señaló `dba-data`): compromete a que `leerBancor` clasifique cada fila contra `DESTINOS_BASE`
  y devuelva el conteo completo (`contarDestinos`), igual que los tres adapters existentes. Se declara
  acá **como requisito del adapter que se escribe a continuación**, no como algo ya verificado — y el
  adapter no está terminado hasta que lo cumpla.

## 7. Lo que este adapter NO hace

- No corta `conceptoBanco` de la glosa (a diferencia de Galicia/Santander): el concepto de Bancor mezcla
  literal y código de referencia en la misma banda sin un corte geométrico confiable medido todavía —
  se declara ausente (`conceptoBancoEstrategia` no se emite) en vez de inventar un corte.
- No clasifica ni decide tratamiento contable: eso es Módulo 2 (`packages/contabilidad`), fuera de
  alcance.
- No construye un campo `jurisdiccion` (ver §4).
- No verifica el bloque de totales de §6 contra la suma de movimientos (pendiente, causa declarada).

## 8. Vocabulario de concepto observado (banco-genérico, no dato de nadie)

`SALDO RES. ANTERIOR`, `IMP.S/OPER.DEBITOS`, `IMP.S/OPER.CREDITOS`, `TRANSF.HB-G`,
`RECAU.SIRCREB CBA`, `CRED.TRANSFERENC.ATM`, `PA.RES.DEB.CTA.AT PR`, `IMP.DEB.EXT.EFVO.GRA`,
`EXTRACCION ATM PROPI`. Se reusa el léxico de Módulo 2 donde el concepto ya sea conocido de otro banco
(p. ej. IVA, Ley 25413 vía `IMP.S/OPER.DEBITOS`/`CREDITOS`); un literal nuevo se reporta sin forzarlo —
mismo criterio que el resto del roster.
