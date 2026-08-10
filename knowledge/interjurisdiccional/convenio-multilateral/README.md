---
name: convenio-multilateral-readme
description: Qué cargar sobre Convenio Multilateral (régimen general, regímenes especiales, SIFERE) y de dónde. Carpeta vacía por ahora.
nivel: interjurisdiccional
regimen: convenio-multilateral
sources_status: esqueleto-sin-contenido
compilado: 2026-08-09
---

# Convenio Multilateral — qué va acá

> **Vacío.** Es la carga que habilita a `fiscal-ingresos-brutos-convenio-multilateral` a responder algo
> sobre reparto interjurisdiccional. Sin esto, ese agente solo puede hablar de IIBB unilateral (y
> únicamente de las provincias que estén cargadas en `knowledge/provincial/`).

## Qué cargar — primero el texto del Convenio

1. **El texto del Convenio Multilateral**, con su número/fecha copiados de la fuente oficial
   (`[A VERIFICAR]` hasta tenerlo). Al menos: ámbito de aplicación (cuándo un contribuyente queda
   comprendido), **régimen general**, **regímenes especiales**, atribución de ingresos y de gastos,
   inicio y cese de actividades, y el rol de los organismos de aplicación.
2. **Resoluciones generales vigentes de la Comisión Arbitral** que interpretan o reglamentan esos puntos.
   Interesan especialmente las que definen **qué gasto es computable y cómo se atribuye**, y las de
   régimen de retenciones/percepciones interjurisdiccionales.
3. **Resoluciones de casos concretos** relevantes para las actividades de la cartera del estudio (son la
   fuente de los criterios finos que después se aplican a un cliente real).

## Estructura

| Subcarpeta | Qué va |
|---|---|
| `regimen-general/` | Mecánica del **coeficiente unificado**: ingresos y gastos del último balance cerrado, qué se computa y qué se excluye, cómo se atribuye cada uno, cuándo se aplica el coeficiente nuevo, y el tratamiento de inicio y cese en una jurisdicción. |
| `regimenes-especiales/` | Cada actividad con reparto propio previsto por el Convenio. **No cargar "los regímenes especiales" en abstracto**: cargar los que aplican (o pueden aplicar) a los clientes reales, uno por archivo, con su cita. |
| `sifere/` | Operatoria de liquidación y presentación, formatos de datos, y acreditación de retenciones y percepciones **por jurisdicción**. |

## Lo que el sistema necesita de esta capa

El coeficiente unificado **no es un número que se guarda**: es un número que tiene que poder
**recalcularse y auditarse**. De la fuente hay que extraer exactamente qué datos hay que capturar para
eso: ingresos y gastos **por jurisdicción**, el balance del que salen, el período de aplicación del
coeficiente, y las exclusiones aplicadas con su motivo. Ver
`agents/personas/plan-cuentas-multicliente.md` (los atributos van versionados por vigencia: un
recálculo de un período cerrado usa el coeficiente que estaba vigente entonces).

## Cómo cargarlo

Un archivo por tema, resumiendo y citando (Convenio + artículo, o resolución + artículo, + URL). Cada
afirmación con marca de confianza y **fecha de verificación**. Texto oficial completo en `fuentes/`,
registrado en `knowledge/_FUENTES.md`.

## De dónde

- **Comisión Arbitral del Convenio Multilateral** — texto del Convenio, resoluciones generales,
  resoluciones de casos concretos, documentación operativa de SIFERE.
- **Comisión Plenaria** — resoluciones de la instancia de revisión.
- Boletines oficiales (nacional y provinciales) para verificar publicación y vigencia.

⚠️ **Nunca extrapolar.** Un criterio de atribución resuelto para una actividad no se traslada a otra, y
una resolución sobre una jurisdicción no habla por las demás. Sin la fuente para el caso exacto: "no
tengo esa fuente cargada".
