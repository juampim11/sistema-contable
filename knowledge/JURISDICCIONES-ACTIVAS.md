---
name: jurisdicciones-activas
description: El modelo multi-jurisdicción de este producto y cómo se resuelve qué jurisdicciones aplican a cada cliente. Leer antes de responder cualquier consulta de IIBB.
sources_status: esqueleto-sin-contenido
compilado: 2026-08-09
---

# Jurisdicciones activas

## No hay UNA jurisdicción activa

Este producto **no tiene una jurisdicción activa única**. Un estudio contable atiende muchos clientes, y
**un mismo cliente puede tener varias jurisdicciones activas al mismo tiempo** por **Convenio
Multilateral**: reparte su base imponible de Ingresos Brutos entre todas las provincias (y CABA) donde
desarrolla actividad.

Esta es la diferencia central con un sistema donde cada ente pertenece a una sola jurisdicción. Acá:

- La jurisdicción **no es un valor global del sistema**.
- La jurisdicción **no es un valor único del cliente**.
- Es una **colección con vigencia** por cliente: qué jurisdicciones tenía activas, **desde cuándo y
  hasta cuándo**.

Consecuencia práctica para los agentes: **una respuesta de IIBB sin jurisdicción identificada es una
respuesta inválida.** Antes de responder hay que saber (a) qué jurisdicciones tiene activas el cliente y
(b) por cuál se pregunta.

Consecuencia práctica para el modelo de datos: ver `agents/personas/plan-cuentas-multicliente.md`. Un
recálculo de un período cerrado tiene que usar **las jurisdicciones vigentes en ese período**, no las de
hoy.

## Cómo se resuelve, hoy

```
1. ¿De qué cliente se trata?              → knowledge/clientes/CLIENTE-<id>/jurisdicciones-activas.md
2. ¿Es unilateral o de Convenio?          → ese mismo archivo lo declara
3. ¿Qué normativa se lee?
   ├── Nacional (IVA, Ganancias, SIRE)    → knowledge/nacional/
   ├── Reparto interjurisdiccional        → knowledge/interjurisdiccional/convenio-multilateral/
   └── IIBB de cada jurisdicción activa   → knowledge/provincial/<provincia>/iibb/
4. ¿Falta alguna de esas carpetas?        → "no tengo esa fuente cargada" para ese punto
```

**No existe extrapolación entre jurisdicciones.** Si está cargada la provincia A y se pregunta por la B,
la respuesta es "no tengo esa fuente cargada" — nunca "en A es así, probablemente en B también".

## Estado actual

- **Clientes cargados:** ninguno. `knowledge/clientes/` tiene solo la plantilla.
- **Nacional:** carpetas creadas (`iva/`, `ganancias/`, `sire/`), **sin contenido**.
- **Interjurisdiccional:** carpetas creadas (`regimen-general/`, `regimenes-especiales/`, `sifere/`),
  **sin contenido**.
- **Provincial:** **ninguna provincia creada todavía.** Se crea la primera cuando se sepa la provincia
  del **cliente piloto** — patrón en `knowledge/provincial/README.md` y plantilla en
  `_PLANTILLA-provincia.md`.

Hasta que haya contenido real, los agentes fiscales van a responder **"no tengo esa fuente cargada"**
ante casi todo. Es el guardrail funcionando.

## Cómo dar de alta una jurisdicción nueva

1. `cp knowledge/provincial/_PLANTILLA-provincia.md knowledge/provincial/<provincia>/iibb/README.md` y
   responder sus preguntas con fuente oficial.
2. Cargar el código tributario y la **ley impositiva del año en curso** de esa jurisdicción, más los
   regímenes de retención/percepción aplicables (ver `docs/agents/guia-carga-conocimiento.md`).
3. Registrar las descargas y los huecos en `knowledge/_FUENTES.md`.
4. Agregar la jurisdicción al archivo del cliente que la activó
   (`knowledge/clientes/CLIENTE-<id>/jurisdicciones-activas.md`), **con fecha de alta**.
