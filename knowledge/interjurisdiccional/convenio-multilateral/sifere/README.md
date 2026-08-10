---
name: cm-sifere-readme
description: Qué cargar sobre SIFERE (liquidación y presentación de Convenio Multilateral). Carpeta vacía por ahora.
nivel: interjurisdiccional
sistema: sifere
sources_status: esqueleto-sin-contenido
compilado: 2026-08-09
---

# SIFERE — qué va acá

> **Vacío.** Fuente: Comisión Arbitral del Convenio Multilateral (ver `../README.md` §De dónde).

## Qué cargar

1. **Norma y documentación operativa vigentes** del sistema de liquidación y presentación para
   contribuyentes de Convenio Multilateral, con su número copiado de la fuente (`[A VERIFICAR]` hasta
   tenerlo) y la **versión** del sistema/manual consultada.
2. **Qué se declara y con qué periodicidad**: declaración mensual por jurisdicción, declaración anual, y
   los plazos de vencimiento.
3. **Formato de los datos**: campos obligatorios, formato de importes y fechas, y las validaciones que
   rechazan una presentación. Esto es insumo directo del modelo de datos.
4. **Retenciones y percepciones por jurisdicción**: cómo se informan y se acreditan, qué respaldo exige
   cada una, y cómo se tratan los **saldos a favor por jurisdicción** (no son intercambiables entre
   jurisdicciones — el sistema tiene que llevarlos separados).
5. **Rectificativas**: cómo se corrige una presentación y qué arrastra.

## Lo que el sistema necesita capturar

| Dato | Por qué |
|---|---|
| Cada retención/percepción con **su jurisdicción**, importe, fecha y comprobante | Sin la jurisdicción, la acreditación no se puede armar |
| Saldo a favor **por jurisdicción**, con su evolución | Los saldos no se compensan entre jurisdicciones |
| Base imponible atribuida a cada jurisdicción y el coeficiente usado | Trazabilidad de la declaración presentada |
| Versión del formato con el que se generó cada presentación | Cuando el formato cambia, saber qué se presentó con cuál |

## Cómo cargarlo

`01-declaraciones-y-plazos.md`, `02-formato-de-datos.md`, `03-retenciones-percepciones-y-saldos.md`.
Cada afirmación con cita, marca de confianza y **fecha de verificación**; anotar la versión del manual
oficial consultado.

⚠️ Ningún nombre de campo, formato de archivo ni número de resolución se escribe de memoria: un campo
inventado hace fallar la presentación en silencio. Si hay integración técnica, la define
`agents/personas/integraciones-afip.md` con la documentación oficial citada.
