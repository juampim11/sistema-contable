---
name: nacional-ganancias-readme
description: Qué cargar sobre Impuesto a las Ganancias (personas humanas y sociedades) y de dónde. Carpeta vacía por ahora.
nivel: nacional
impuesto: ganancias
sources_status: esqueleto-sin-contenido
compilado: 2026-08-09
---

# Ganancias — qué va acá

> **Vacío.** Es una de las dos cargas del **mínimo viable** (junto con IVA).

## Qué cargar

1. **Ley del impuesto (texto ordenado vigente) y su decreto reglamentario.**
2. **Personas humanas:** categorías de renta, criterio de imputación (percibido/devengado según
   categoría), **deducciones personales con sus importes del período** (mínimo no imponible, cónyuge,
   hijos, deducción especial), otras deducciones admitidas y sus topes, **escala del artículo
   correspondiente** para el período fiscal, y régimen de retención sobre rentas del trabajo.
3. **Sociedades:** determinación del resultado impositivo, **ajustes del resultado contable al
   impositivo** (el punto que más importa para el sistema: hay que poder registrarlos y trazarlos),
   alícuota o escala societaria vigente, tratamiento de dividendos/utilidades.
4. **Anticipos:** base de cálculo, cantidad, vencimientos y régimen de reducción.
5. **Retenciones de Ganancias:** regímenes aplicables, mínimos no sujetos a retención y escalas de
   retención, cómo se computan las sufridas. Cruza con `sire/`.
6. **Ajuste por inflación impositivo**, si corresponde al período y al sujeto: condiciones de
   aplicación y mecánica.

⚠️ **Los importes de deducciones personales, los mínimos de retención y la escala se actualizan.**
Cargar el **período fiscal que se necesita**, anotarlo en el frontmatter y no reusar el archivo del año
anterior sin verificarlo. Es el dato que más se cita mal.

## Cómo cargarlo

Un archivo por tema (`01-personas-humanas-categorias.md`, `02-deducciones-y-escala-<periodo>.md`,
`03-sociedades-resultado-impositivo.md`, `04-anticipos.md`, `05-retenciones.md`, …), resumiendo y
citando. Los importes y escalas de un período conviene tenerlos en **su propio archivo con el período en
el nombre**, para que quede evidente cuando falta el del año siguiente.

Cada afirmación con marca de confianza, cita (norma + artículo + URL) y **fecha de verificación**.

## De dónde

- Portal oficial del organismo recaudador nacional (micrositio del impuesto, valores vigentes).
- `infoleg.gob.ar` / `argentina.gob.ar/normativa` — texto actualizado de la ley y el decreto.
- `boletinoficial.gob.ar` — verificación de la última modificación y su vigencia (los importes suelen
  actualizarse por norma publicada ahí).
