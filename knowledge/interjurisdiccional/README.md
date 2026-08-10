---
name: interjurisdiccional-readme
description: Índice de la capa interjurisdiccional. Qué es y por qué está separada de lo nacional y de lo provincial.
nivel: interjurisdiccional
sources_status: esqueleto-sin-contenido
compilado: 2026-08-09
---

# Capa interjurisdiccional

> **Vacío.** Ver `convenio-multilateral/README.md`.

## Por qué existe esta capa

No es nacional (no la dicta el Estado nacional ni la aplica el organismo recaudador nacional) y no es
provincial (no la dicta una provincia sola). Es el **acuerdo entre las jurisdicciones** para repartir la
base imponible de Ingresos Brutos de un contribuyente que trabaja en varias, más los **organismos** que
lo administran y el **sistema de liquidación** que usan.

Mezclarla con lo provincial es el error que hace que un sistema conteste mal: el **reparto** de la base
sale de esta capa, y la **alícuota** que se aplica a la porción repartida sale de la capa provincial de
cada jurisdicción. Son dos preguntas distintas, con dos fuentes distintas.

```
Base imponible total del cliente
        │
        ├── ¿cómo se reparte entre jurisdicciones?  → interjurisdiccional/  (esta capa)
        │
        └── ¿qué alícuota se aplica a la porción de cada una?  → provincial/<provincia>/iibb/
```

## Estructura

| Subcarpeta | Contenido |
|---|---|
| `convenio-multilateral/regimen-general/` | Coeficiente unificado: atribución de ingresos y gastos, qué se computa y qué no, balance de origen, período de aplicación, inicio y cese de actividad. |
| `convenio-multilateral/regimenes-especiales/` | Actividades con reparto previsto por el propio Convenio, distinto del general. |
| `convenio-multilateral/sifere/` | Sistema de liquidación y presentación: operatoria, formatos, y acreditación de retenciones y percepciones por jurisdicción. |

## De dónde se saca

- **Comisión Arbitral del Convenio Multilateral** — texto del Convenio, resoluciones generales,
  resoluciones de casos concretos, y la documentación operativa del sistema de liquidación. Es la fuente
  primaria de esta capa.
- **Comisión Plenaria** — instancia de revisión; sus resoluciones también son fuente.
- `boletinoficial.gob.ar` y los boletines oficiales provinciales, para la publicación de las normas de
  adhesión y de las resoluciones.

⚠️ Ningún número de resolución de la Comisión Arbitral se escribe de memoria: se copia de la fuente, con
URL y fecha de consulta.
