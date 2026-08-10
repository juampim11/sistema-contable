---
name: provincial-readme
description: Patrón de la capa provincial (IIBB por jurisdicción). Ninguna provincia creada todavía - se crea la primera cuando se sepa la del cliente piloto.
nivel: provincial
sources_status: esqueleto-sin-contenido
compilado: 2026-08-09
---

# Capa provincial — IIBB por jurisdicción

> **Ninguna provincia creada todavía.** Es deliberado: no se crea una carpeta de provincia hasta saber
> **qué jurisdicción** necesita un cliente real. Cargar provincias "por las dudas" es trabajo de
> relevamiento que envejece antes de usarse (las leyes impositivas se actualizan al menos una vez por
> año).

## El patrón

```
knowledge/provincial/<provincia>/
└── iibb/
    ├── README.md              ← copiado de ../_PLANTILLA-provincia.md y completado
    ├── 01-codigo-tributario-iibb.md
    ├── 02-ley-impositiva-<año>.md      ← alícuotas por actividad, del año en curso
    ├── 03-retenciones-y-percepciones.md
    ├── 04-exenciones-y-regimenes-especiales.md
    └── fuentes/                        ← textos oficiales descargados, con fecha
```

`<provincia>` en kebab-case y sin acentos: `cordoba`, `buenos-aires`, `caba`, `santa-fe`, `entre-rios`.

**Por qué `iibb/` como subcarpeta y no archivos sueltos en la provincia:** si más adelante hace falta
Sellos, Inmobiliario u otro tributo provincial, entra como carpeta hermana (`sellos/`, `inmobiliario/`)
sin reorganizar nada.

## Cómo dar de alta la primera provincia

1. `cp knowledge/provincial/_PLANTILLA-provincia.md knowledge/provincial/<provincia>/iibb/README.md`
2. Responder las preguntas de la plantilla **con fuente oficial y URL** — sin inventar ningún número.
3. Cargar los archivos de contenido (código tributario, **ley impositiva del año en curso**, regímenes
   de retención/percepción, exenciones).
4. Registrar descargas y huecos en `knowledge/_FUENTES.md`.
5. Agregar la jurisdicción al archivo del cliente que la activó
   (`knowledge/clientes/CLIENTE-<id>/jurisdicciones-activas.md`), con fecha de alta.

## De dónde se saca (patrón, vale para cualquier provincia)

- **Organismo de recaudación provincial** (la Dirección/Agencia de Rentas de la provincia, o AGIP en
  CABA): código tributario, ley impositiva vigente, resoluciones, padrones de alícuotas y regímenes de
  retención/percepción.
- **Boletín Oficial de la provincia**: texto y fecha de publicación de la ley impositiva anual y de las
  resoluciones.
- **Comisión Arbitral** para lo que sea reparto interjurisdiccional (esa es
  `knowledge/interjurisdiccional/`, no esta capa).

⚠️ **La ley impositiva es anual.** Cargar la del **año en curso** y anotar el año en el nombre del
archivo, para que se vea a simple vista cuándo quedó vieja. Y verificar la **numeración del texto
ordenado vigente** del código tributario antes de citar un artículo: los códigos provinciales se
renumeran (ver `knowledge/README.md` §Convenciones 4).

## Regla de aislamiento entre jurisdicciones

**Nunca se extrapola de una provincia a otra.** Ni alícuotas, ni exenciones, ni regímenes de retención,
ni criterios. Si se pregunta por una provincia que no está cargada, la respuesta es **"no tengo esa
fuente cargada"**.
