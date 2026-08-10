# Guía de carga de conocimiento — qué cargar primero y de dónde

> Para que los agentes fiscales y contables sirvan de algo, alguien (vos o un profesional matriculado)
> tiene que cargar **contenido real** en `knowledge/`. Este documento dice **QUÉ** cargar, en **qué
> orden** y **DÓNDE** conseguirlo (fuente oficial).
>
> **Lo que este documento NO hace: transcribir normativa.** No hay acá ni una alícuota, ni un tope, ni
> un número de artículo. Los datos concretos se sacan de la fuente oficial vigente al momento de
> cargarlos — **nunca de memoria, y nunca de este documento.**
>
> **Recordatorio permanente:** toda norma fiscal cambia, y las de este país cambian seguido (alícuotas,
> mínimos, escalas, deducciones, padrones, formatos de presentación). Al cargar cada archivo, anotar el
> **período fiscal que cubre** y la **fecha de verificación de vigencia**, y volver a revisar antes de
> que un agente se apoye en ella para algo real. Ver `knowledge/README.md` §Convenciones.

---

## 0. Antes de cargar nada: leer las convenciones

`knowledge/README.md` tiene las siete convenciones obligatorias (marcas de confianza, vigencia y fecha
de verificación, número de norma copiado y no recordado, renumeración de textos ordenados, adopción
jurisdiccional de las RT, no transcribir, y nada de datos de clientes). **Un archivo cargado sin
respetarlas es peor que la carpeta vacía**: la carpeta vacía hace que el agente diga "no tengo esa fuente
cargada"; un archivo mal cargado hace que el agente afirme algo con cara de verificado.

Y registrar cada descarga y cada hueco en `knowledge/_FUENTES.md`. Ese archivo es el índice único de
huecos del repo: un hueco anotado es un ítem de trabajo, un hueco no anotado es una sorpresa.

---

## 1. Mínimo viable — lo que hay que cargar para que esto arranque

Tres bloques, en este orden. Con los dos primeros, `fiscal-nacional-iva-ganancias` empieza a servir para
**toda** la cartera del estudio. Con el tercero, `fiscal-ingresos-brutos-convenio-multilateral` empieza a
servir para **un** cliente (el piloto).

### 1.1. IVA nacional → `knowledge/nacional/iva/`

**Por qué primero:** es el impuesto que atraviesa todos los meses de todos los clientes, y es el que más
depende de datos que el sistema tiene que capturar bien desde el comprobante.

**Qué:** ley del impuesto (texto ordenado vigente) y decreto reglamentario — hecho imponible, sujetos,
exenciones, débito fiscal, **crédito fiscal y sus requisitos de cómputo**, **prorrateo** cuando hay
operaciones gravadas y exentas/no gravadas, período fiscal y liquidación, saldo técnico vs. de libre
disponibilidad. Más: **alícuotas vigentes** con el período que cubren, y los **regímenes generales de
retención y percepción** (quién es agente, sobre qué operaciones, mínimos, cómputo de las sufridas).

**Dónde:**
- **Portal oficial del organismo recaudador nacional** (micrositio del impuesto + sección de normativa +
  valores vigentes).
- **`infoleg.gob.ar`** / **`argentina.gob.ar/normativa`** — texto actualizado de la ley y el decreto, con
  las modificaciones incorporadas.
- **`boletinoficial.gob.ar`** — para confirmar la última modificación puntual y su fecha de vigencia.

⚠️ Los **mínimos no sujetos a retención** se actualizan. Copiar el número de cada resolución general de
la fuente, con URL: **no escribir "RG ...." de memoria.**

### 1.2. Ganancias nacional → `knowledge/nacional/ganancias/`

**Qué:** ley (texto ordenado vigente) y decreto reglamentario, para los dos sujetos:
- **Personas humanas:** categorías de renta, criterio de imputación, **deducciones personales con los
  importes del período**, otras deducciones y sus topes, **escala del período fiscal**, retención sobre
  rentas del trabajo.
- **Sociedades:** determinación del resultado impositivo, **ajustes del resultado contable al
  impositivo** (lo que más le importa al sistema: hay que poder registrarlos y trazarlos), alícuota o
  escala societaria vigente, tratamiento de dividendos/utilidades.
- **Anticipos** y **regímenes de retención** de Ganancias.

**Dónde:** las mismas tres fuentes de IVA.

⚠️ **Este es el bloque que envejece más rápido.** Deducciones, escala y mínimos de retención cambian de
período a período (y a veces dentro del período). Conviene poner los importes y la escala en un archivo
**con el período en el nombre** (`02-deducciones-y-escala-<periodo>.md`), para que se vea a simple vista
cuando falta el del año siguiente.

### 1.3. IIBB de la primera provincia real → `knowledge/provincial/<provincia>/iibb/`

**Esto está bloqueado por un dato de negocio, no por trabajo:** hace falta saber **en qué provincia opera
el cliente piloto**. No se carga una provincia "por las dudas": la ley impositiva es anual y el
relevamiento envejece antes de usarse.

**Qué:** copiar `knowledge/provincial/_PLANTILLA-provincia.md` y responder sus siete secciones. En
concreto: **código tributario** (texto ordenado vigente), **ley impositiva del año en curso** (alícuota
general y diferenciales por actividad, mínimos), **regímenes de retención y percepción provinciales**
(incluido el padrón de alícuotas si la jurisdicción usa uno), **exenciones** y regímenes especiales
propios, y la **forma de presentación**.

**Dónde:**
- **Organismo de recaudación de esa provincia** (la Dirección o Agencia de Rentas provincial; en CABA,
  AGIP): código tributario, ley impositiva, resoluciones, padrones.
- **Boletín Oficial de la provincia**: texto y fecha de publicación de la ley impositiva anual y de las
  resoluciones.

⚠️ **Verificar la numeración del texto ordenado vigente** antes de citar un artículo del código
tributario: los códigos provinciales se renumeran entre textos ordenados y es una fuente clásica de cita
equivocada.

---

## 2. Segundo tramo — cuando el cliente piloto es de Convenio Multilateral

Si el piloto opera en **más de una jurisdicción**, el mínimo viable se extiende:

### 2.1. Convenio Multilateral → `knowledge/interjurisdiccional/convenio-multilateral/`

**Qué:** el **texto del Convenio** (ámbito de aplicación, régimen general, regímenes especiales,
atribución de ingresos y gastos, inicio y cese de actividad), las **resoluciones generales vigentes de
la Comisión Arbitral** que lo reglamentan —sobre todo las de **gastos computables y su atribución** y las
de retenciones/percepciones interjurisdiccionales—, y las **resoluciones de casos concretos** de las
actividades de la cartera.

**Dónde:** **Comisión Arbitral del Convenio Multilateral** (fuente primaria: texto del Convenio,
resoluciones generales, resoluciones de casos concretos, documentación operativa) y **Comisión Plenaria**
para la instancia de revisión. Publicación y vigencia se verifican en los boletines oficiales.

**Y además: la ley impositiva de CADA jurisdicción activa** (§1.3, repetido por provincia). El reparto
sale del Convenio; **la alícuota que se aplica a cada porción sale de la provincia**. Son dos fuentes
distintas y no se sustituyen.

### 2.2. SIFERE → `knowledge/interjurisdiccional/convenio-multilateral/sifere/`

**Qué:** norma y documentación operativa vigentes (con la **versión** del manual consultada), qué se
declara y con qué periodicidad, **formato de los datos y validaciones**, y el tratamiento de retenciones,
percepciones y **saldos a favor por jurisdicción** (que no se compensan entre jurisdicciones).

**Dónde:** Comisión Arbitral — documentación operativa del sistema.

---

## 3. Tercer tramo — cuando el estudio tiene que emitir estados contables

### 3.1. RT de la FACPCE → `knowledge/nacional/`, en una subcarpeta `rt-facpce/`

> Esa subcarpeta **todavía no existe**: se crea al cargar el primer archivo, no antes (convención de
> `knowledge/README.md`: las carpetas se crean cuando tienen contenido que justificarlas).

**Qué:** el juego de normas contables profesionales aplicable (marco conceptual, exposición, medición) y
la **variante para entes pequeños y medianos — RT 41**, más lo relativo al **ajuste por inflación**
(condiciones de obligatoriedad y mecánica de reexpresión).

⚠️ **Los números de RT se copian de la fuente oficial, no de memoria.** El único número que este
documento afirma es **RT 41** para entes pequeños y medianos, porque lo indicó el usuario al definir el
alcance del agente `balances-normas-tecnicas` — y aun así se verifica contra FACPCE al cargarlo. Todos
los demás (marco conceptual, exposición, medición, ajuste por inflación) se relevan y se anotan con su
número verificado. Hasta entonces van como `[A VERIFICAR]`.

**Y el paso que se olvida:** la **adopción de cada RT por el Consejo Profesional de la jurisdicción**
donde el estudio y sus clientes están matriculados. Una RT emitida por FACPCE rige en la jurisdicción que
la adoptó; sin la adopción cargada, el agente lo marca como pendiente en vez de asumirla.

**Dónde:**
- **FACPCE** (`facpce.org.ar`) — texto de las Resoluciones Técnicas y sus modificatorias e
  interpretaciones.
- **Consejo Profesional de Ciencias Económicas de la jurisdicción** — la resolución de adopción y sus
  eventuales adecuaciones locales.

### 3.2. SIRE → `knowledge/nacional/sire/`

Cargar cuando algún cliente sea **agente de retención**. Alcance (qué regímenes se informan por ahí y
cuáles no), sujetos obligados, operatoria y plazos de emisión del certificado, y **formato de los datos**
—este último es insumo directo del modelo de datos: si un campo obligatorio no se captura en el momento
del pago, después se reconstruye a mano, que es justo lo que el producto tiene que evitar.

**Dónde:** portal oficial del organismo recaudador nacional (micrositio del régimen, manuales,
documentación para desarrolladores) y el Boletín Oficial para el texto de las resoluciones.

### 3.3. Rieles técnicos → insumo de `integraciones-afip`

Documentación oficial de los webservices (autenticación, facturación electrónica, constatación de
comprobantes, padrón), **con entornos de homologación y producción diferenciados**, y el ciclo de vida de
los certificados. Se cita con URL y fecha de consulta.

⚠️ **La denominación del organismo cambió de AFIP a ARCA.** La denominación exacta vigente, las URLs y
los nombres de servicio se **verifican contra la fuente oficial** antes de escribirlos en un doc o en
código — la documentación pública convive con las dos denominaciones.

### 3.4. Secreto fiscal y datos personales → insumo de `seguridad-datos-financieros`

Normas de **secreto fiscal** y de **protección de datos personales** aplicables (con artículos), y los
**plazos legales de conservación** de documentación respaldatoria. Sin esto, el agente de seguridad no
puede afirmar ninguna obligación legal de retención o de notificación de incidentes.

**Dónde:** `infoleg.gob.ar` / `argentina.gob.ar/normativa` para los textos; la autoridad de aplicación de
protección de datos personales para su normativa reglamentaria. ⚠️ Verificar vigencia y reformas: es un
área con proyectos de reforma en curso.

---

## 4. Orden recomendado, en una tabla

| # | Bloque | Carpeta | Habilita | Bloqueado por |
|---|---|---|---|---|
| 1 | IVA nacional | `nacional/iva/` | `fiscal-nacional-iva-ganancias` para toda la cartera | nada — se puede empezar hoy |
| 2 | Ganancias nacional | `nacional/ganancias/` | ídem | nada |
| 3 | IIBB primera provincia | `provincial/<provincia>/iibb/` | `fiscal-ingresos-brutos-convenio-multilateral` para el piloto | **saber la provincia del piloto** |
| 4 | Convenio Multilateral | `interjurisdiccional/convenio-multilateral/` | reparto interjurisdiccional | solo si el piloto es de Convenio |
| 5 | Ley impositiva de cada jurisdicción adicional | `provincial/<j>/iibb/` | alícuota de cada porción repartida | saber las jurisdicciones del piloto |
| 6 | SIFERE | `.../sifere/` | liquidación y presentación de Convenio | ídem |
| 7 | RT FACPCE + adopción local | `nacional/rt-facpce/` | `balances-normas-tecnicas` y `contador-dominio` | nada |
| 8 | SIRE | `nacional/sire/` | retenciones electrónicas | que un cliente sea agente |
| 9 | Webservices y certificados | insumo de `integraciones-afip` | integraciones técnicas | nada |
| 10 | Secreto fiscal y datos personales | `nacional/` | `seguridad-datos-financieros` | nada |

---

## 5. Antes de que los agentes se apoyen en esto

1. Cargar **IVA + Ganancias nacional** — es el piso para que el agente fiscal nacional sirva para el
   100 % de la cartera.
2. Cargar el **IIBB de la primera provincia real** en cuanto se sepa cuál es. Si el piloto es de
   Convenio, cargar también el **Convenio** y la ley impositiva de **cada** jurisdicción activa.
3. Todo lo demás se suma de forma incremental. Mientras falte, los agentes van a decir **"no tengo esa
   fuente cargada"** para esos temas: **es el comportamiento esperado, no un bug.**
4. Idealmente, que un **profesional matriculado** (contador para lo contable y lo fiscal) revise la
   selección de fuentes antes de darla por buena. **Este documento la propone, no la valida.** Y todo
   output de los agentes que tenga implicancia real cierra con **"Validar con profesional matriculado"**
   por la misma razón.
5. Anotar en `knowledge/_FUENTES.md` cada descarga y cada hueco — y también **cada supuesto de esta guía
   que el relevamiento contradiga** (Parte 3 de ese archivo). Esta guía se escribió **antes** de leer las
   fuentes: es esperable que algo no cierre. Lo inaceptable es que la contradicción quede sin registrar.
