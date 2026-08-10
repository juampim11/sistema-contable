---
name: cm-regimenes-especiales-readme
description: Qué cargar sobre los regímenes especiales del Convenio Multilateral. Carpeta vacía por ahora.
nivel: interjurisdiccional
regimen: convenio-multilateral-especiales
sources_status: esqueleto-sin-contenido
compilado: 2026-08-09
---

# Regímenes especiales

> **Vacío.** Fuente: Comisión Arbitral del Convenio Multilateral (ver `../README.md` §De dónde).

## Qué son y por qué importan acá

Son actividades para las que el propio Convenio prevé un **reparto distinto del régimen general** —en
lugar de calcular un coeficiente a partir de ingresos y gastos, la base se distribuye según proporciones
o criterios fijados por la norma para esa actividad.

Consecuencia para el sistema: **el encuadre del cliente no es un dato menor**. Si una actividad cae en un
régimen especial y se la calcula por el general (o al revés), el resultado está mal aunque toda la
aritmética esté bien. Y un mismo cliente puede tener **una actividad en régimen especial y otra en el
general** a la vez.

## Qué cargar

- **Un archivo por régimen especial**, y solo los que aplican (o pueden aplicar) a la cartera real del
  estudio. Cargar los demás en abstracto es trabajo sin destino.
- De cada uno: **qué actividad alcanza** (con la mayor precisión que dé la fuente, porque el borde del
  encuadre es lo que se discute), **cómo se reparte** la base, y **desde/hasta** cuándo rige esa
  redacción.
- **Resoluciones de casos concretos** que definan el borde del encuadre de esa actividad.
- Los criterios sobre **actividades concurrentes** (parte especial, parte general) en un mismo
  contribuyente.

⚠️ **No inferir el encuadre de un cliente por parecido con otro.** El encuadre se afirma con la cita del
artículo que lo prevé; sin ella, "no tengo esa fuente cargada".

## Cómo cargarlo

`01-<nombre-de-la-actividad>.md`, uno por régimen, con cita (Convenio + artículo, resolución + artículo,
+ URL), marca de confianza y **fecha de verificación**. Anotar en `knowledge/_FUENTES.md` qué regímenes
quedaron sin relevar y por qué (normalmente: ningún cliente los necesita todavía).
