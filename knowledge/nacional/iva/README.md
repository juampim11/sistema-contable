---
name: nacional-iva-readme
description: Qué cargar sobre IVA y de dónde. Carpeta vacía por ahora.
nivel: nacional
impuesto: iva
sources_status: esqueleto-sin-contenido
compilado: 2026-08-09
---

# IVA — qué va acá

> **Vacío.** Es una de las dos cargas del **mínimo viable** (junto con Ganancias): sin esto,
> `fiscal-nacional-iva-ganancias` no puede responder nada de IVA.

## Qué cargar

1. **Ley del impuesto (texto ordenado vigente) y su decreto reglamentario.** Al menos: objeto y hecho
   imponible, sujetos, exenciones, nacimiento del débito fiscal, **crédito fiscal y sus requisitos de
   cómputo**, **prorrateo** cuando hay operaciones gravadas y exentas/no gravadas, período fiscal y
   liquidación, saldo técnico vs. saldo de libre disponibilidad.
2. **Alícuotas vigentes** (general, diferenciales y reducidas) con el período que cubren.
3. **Regímenes de retención y percepción de IVA**: quién es agente, sobre qué operaciones, mínimos, y
   cómo se computan las sufridas. Los mínimos se actualizan: anotar período y fecha de verificación.
4. **Requisitos formales del comprobante** para que el crédito sea computable (y la constatación de su
   validez — cruza con `integraciones-afip`).
5. **Situaciones especiales de la cartera del estudio** a medida que aparezcan: operaciones de
   exportación, servicios digitales, actividades con tratamiento propio, responsables sustitutos.

## Cómo cargarlo

Un archivo por tema (`01-hecho-imponible-y-sujetos.md`, `02-credito-fiscal-y-prorrateo.md`,
`03-retenciones-y-percepciones.md`, …), **resumiendo y citando**, no transcribiendo. El texto oficial
completo va en `fuentes/` con su fecha de descarga, registrado en `knowledge/_FUENTES.md`.

Cada afirmación con su marca (`[VERIFICADO]` / `[A VERIFICAR]` / `[NO ENCONTRADO]`), su cita (norma +
artículo/inciso + URL) y su **fecha de verificación**. Ver `knowledge/README.md` §Convenciones.

## De dónde

- Portal oficial del organismo recaudador nacional (micrositio del impuesto + normativa).
- `infoleg.gob.ar` / `argentina.gob.ar/normativa` — texto actualizado de la ley y el decreto.
- `boletinoficial.gob.ar` — verificación de la última modificación y su vigencia.

⚠️ **No escribir de memoria el número de ninguna resolución general de retención/percepción.** Se copia
de la fuente, con URL. Ver `knowledge/README.md` §Convenciones 3.
