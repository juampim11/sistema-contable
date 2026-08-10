---
name: nacional-sire-readme
description: Qué cargar sobre el régimen SIRE (retenciones electrónicas) y de dónde. Carpeta vacía por ahora.
nivel: nacional
regimen: sire
sources_status: esqueleto-sin-contenido
compilado: 2026-08-09
---

# SIRE — qué va acá

> **Vacío.** Prioridad inmediatamente posterior a IVA y Ganancias: sirve cuando algún cliente del
> estudio es **agente de retención**.

## Qué cargar

1. **La norma que establece el régimen** y las que lo modifican o amplían — con su número copiado de la
   fuente oficial, nunca de memoria. `[A VERIFICAR]` hasta tenerla.
2. **Alcance:** qué regímenes de retención/percepción se informan por SIRE y cuáles quedan afuera. Es lo
   primero que hay que saber para no informar por el canal equivocado.
3. **Sujetos obligados:** quién debe usarlo, desde cuándo, y qué pasa si un cliente pasa a ser agente
   de retención en medio de un período.
4. **Operatoria:** generación del certificado de retención, **plazos de emisión y entrega**,
   periodicidad de la presentación, forma de rectificar, y qué se hace con una retención practicada de
   más o de menos.
5. **Formato de los datos** que exige el sistema: campos obligatorios, formato de importes y fechas,
   validaciones. Esto es insumo directo del modelo de datos: el sistema tiene que capturar **desde el
   momento del pago** todo lo que después SIRE va a exigir. Si un campo obligatorio no se captura al
   pagar, se reconstruye a mano después — que es exactamente lo que el producto tiene que evitar.
6. **Documentación técnica** si hay integración por webservice (o si la presentación es solo por
   aplicativo/portal): eso lo define `integraciones-afip`, con la doc oficial citada.

## Cómo cargarlo

`01-alcance-y-sujetos.md`, `02-operatoria-y-plazos.md`, `03-formato-de-datos.md`. Cada afirmación con
marca de confianza, cita y **fecha de verificación**. El régimen y sus formatos cambian: anotar la
versión de la documentación consultada.

## De dónde

- Portal oficial del organismo recaudador nacional: micrositio del régimen, manuales del sistema y
  documentación para desarrolladores.
- `boletinoficial.gob.ar` / `infoleg.gob.ar` — texto de las resoluciones generales que lo regulan.

⚠️ **Ningún número de resolución general, nombre de campo ni endpoint se escribe de memoria.** Un nombre
de campo inventado hace fallar la presentación en silencio. Ver `knowledge/README.md` §Convenciones 3 y
`agents/personas/integraciones-afip.md`.
