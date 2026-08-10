---
name: knowledge-readme
description: Índice y convenciones de la base de conocimiento normativo. Leer primero, antes de cargar o de citar cualquier archivo.
sources_status: esqueleto-sin-contenido
compilado: 2026-08-09
---

# Base de conocimiento normativo — índice y convenciones

> **ESTADO: ESQUELETO. No hay ni una norma cargada todavía.** Esta carpeta es la estructura vacía que
> van a leer los agentes fiscales y contables. Mientras esté vacía, esos agentes van a responder
> **"no tengo esa fuente cargada"** ante casi cualquier consulta: **es el comportamiento correcto
> (guardrail), no un bug.**
>
> Qué cargar primero y de dónde: **`docs/agents/guia-carga-conocimiento.md`**.

## Por qué existe esta carpeta

Los agentes de dominio (`contador-dominio`, `fiscal-nacional-iva-ganancias`,
`fiscal-ingresos-brutos-convenio-multilateral`, `integraciones-afip`, `balances-normas-tecnicas`,
`seguridad-datos-financieros`) **no responden de memoria**. Responden **solo** con base en los archivos
de esta carpeta, citando el archivo de origen. Es la diferencia entre una herramienta usable en un
estudio contable y un generador de números plausibles.

## Estructura

```
knowledge/
├── README.md                       ← este archivo (índice + convenciones). Leer primero.
├── JURISDICCIONES-ACTIVAS.md       ← el modelo multi-jurisdicción y cómo se resuelve por cliente
├── _FUENTES.md                     ← manifiesto de descargas + registro de huecos pendientes
├── nacional/                       ← AFIP/ARCA: IVA, Ganancias, SIRE
│   ├── iva/
│   ├── ganancias/
│   └── sire/
├── interjurisdiccional/
│   └── convenio-multilateral/      ← régimen general, regímenes especiales, SIFERE
│       ├── regimen-general/
│       ├── regimenes-especiales/
│       └── sifere/
├── provincial/                     ← una carpeta por provincia (o CABA), con su IIBB
│   └── _PLANTILLA-provincia.md     ← se copia para crear la primera provincia real
└── clientes/                       ← qué jurisdicciones tiene activas cada cliente
    └── _PLANTILLA-jurisdicciones-activas.md
```

**Las carpetas de nivel contable (RT de FACPCE)** se cargan dentro de `nacional/` cuando se relevan
(las RT son de alcance nacional en su emisión, pero **su adopción es jurisdiccional**, por el Consejo
Profesional de cada provincia — ver la convención de adopción más abajo). La subcarpeta se crea al
cargar el primer archivo, no antes.

## Convenciones (obligatorias para todo archivo que se cargue)

**1. Marcas de confianza.** Cada afirmación lleva una:
- `[VERIFICADO]` — contrastado contra fuente oficial, con URL en el archivo.
- `[A VERIFICAR]` — plausible pero sin fuente oficial confirmada. **No usar como base de una decisión.**
- `[NO ENCONTRADO]` — se buscó y no se halló fuente. Puede no existir, o no ser pública.

**2. Vigencia y fecha de verificación — en cada dato fiscal, sin excepción.** Alícuotas, mínimos,
topes de deducciones, escalas, coeficientes y padrones de retención **cambian varias veces por año**.
Todo archivo indica el **período fiscal que cubre** y **cuándo se verificó**. Un número sin fecha de
verificación es un número sospechoso, y los agentes lo tratan como tal.

**3. Número de norma: se copia, no se recuerda.** Ningún número de ley, decreto, resolución general,
resolución de la Comisión Arbitral o Resolución Técnica se escribe de memoria. Se copia de la fuente
oficial, con su URL. **Un número de norma inventado es el peor error posible en este repo**: viaja
citado, parece verificado y nadie lo vuelve a chequear.

**4. Renumeración de textos ordenados.** Los códigos tributarios provinciales y los textos ordenados se
renumeran entre versiones. Al citar un artículo, verificar contra el **texto ordenado vigente**, no
contra una copia vieja, y anotar de qué texto ordenado se tomó.

**5. Adopción jurisdiccional de las RT.** Una Resolución Técnica de la FACPCE rige en la jurisdicción
donde el **Consejo Profesional** local la adoptó. Al cargar una RT, cargar también (o dejar anotado como
hueco) **la adopción en la jurisdicción de los clientes del estudio**.

**6. No transcribir.** Estos archivos **resumen y apuntan**; no reemplazan el texto oficial. El texto
completo se descarga según `_FUENTES.md` y se guarda en una subcarpeta `fuentes/` junto al archivo que
lo cita, anotando la fecha de descarga.

**7. Nada de datos de clientes acá.** Esta carpeta es normativa. Los datos de un cliente concreto van
en `clientes/CLIENTE-<id>/` y **solo lo mínimo necesario** (qué jurisdicciones tiene activas y desde
cuándo). Ni credenciales, ni CUIT en archivos normativos, ni extractos. Ver
`agents/personas/seguridad-datos-financieros.md`.

## Regla de oro para los agentes

Si un tema no está cubierto acá, o está marcado `[A VERIFICAR]` / `[NO ENCONTRADO]`, el agente responde
**"no tengo esa fuente cargada"** y no completa con conocimiento propio. Y todo output con implicancia
legal, fiscal o contable cierra con **"Validar con profesional matriculado"**.
