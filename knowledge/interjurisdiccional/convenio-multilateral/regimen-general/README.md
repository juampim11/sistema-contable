---
name: cm-regimen-general-readme
description: Qué cargar sobre el régimen general del Convenio Multilateral (coeficiente unificado). Carpeta vacía por ahora.
nivel: interjurisdiccional
regimen: convenio-multilateral-general
sources_status: esqueleto-sin-contenido
compilado: 2026-08-09
---

# Régimen general — coeficiente unificado

> **Vacío.** Fuente: Comisión Arbitral del Convenio Multilateral (ver
> `../README.md` §De dónde).

## Qué cargar

- **Ámbito:** cuándo un contribuyente queda comprendido en el régimen general (y cuándo cae en un
  especial en cambio).
- **Coeficiente de ingresos:** qué ingresos se computan, a qué jurisdicción se atribuye cada uno
  (criterio de atribución), qué ingresos se excluyen.
- **Coeficiente de gastos:** qué gastos son computables y cuáles **no**, cómo se atribuyen, y el
  tratamiento de los gastos que no se pueden asignar a una jurisdicción determinada.
- **Coeficiente unificado:** cómo se combinan ambos, cantidad de decimales y criterio de redondeo (dato
  chico que cambia el resultado y que el sistema tiene que replicar exactamente).
- **Balance de origen y período de aplicación:** de qué ejercicio salen los datos y desde qué mes se
  aplica el coeficiente nuevo.
- **Inicio de actividad** en una jurisdicción (mientras no hay balance con datos de esa jurisdicción) y
  **cese** de actividad: cómo se reparte en esos períodos.

## Lo que el sistema necesita capturar

De esta carpeta salen los campos que hacen **recalculable y auditable** al coeficiente:

| Dato | Por qué |
|---|---|
| Ingresos por jurisdicción, del ejercicio de origen | Numerador/denominador del coeficiente de ingresos |
| Gastos computables por jurisdicción, del mismo ejercicio | Ídem para gastos |
| Exclusiones aplicadas, **con su motivo y su cita** | Sin esto el coeficiente no es auditable |
| Ejercicio de origen y período de aplicación | Un recálculo histórico tiene que usar el coeficiente vigente entonces |
| Fecha de alta y de cese de cada jurisdicción | Cambia el reparto de los períodos afectados |

## Cómo cargarlo

`01-ambito-y-encuadre.md`, `02-coeficiente-de-ingresos.md`, `03-coeficiente-de-gastos.md`,
`04-unificado-y-periodo-de-aplicacion.md`, `05-inicio-y-cese.md`. Cada afirmación con cita (Convenio o
resolución + artículo + URL), marca de confianza y **fecha de verificación**.
