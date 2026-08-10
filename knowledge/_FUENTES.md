---
name: fuentes-manifest
description: Manifiesto de descargas (qué se bajó, de dónde, cuándo) y registro de huecos pendientes por prioridad.
sources_status: esqueleto-sin-contenido
compilado: 2026-08-09
---

# Manifiesto de fuentes y huecos pendientes

> Dos funciones: (1) **qué texto oficial se descargó**, de dónde y cuándo — para poder revalidar; y
> (2) **qué falta**, ordenado por prioridad — para que un hueco sea un ítem de trabajo visible y no una
> sorpresa el día que un agente dice "no tengo esa fuente cargada".

## Parte 1 — Descargas

Guardar cada texto oficial en una subcarpeta `fuentes/` **junto al archivo de conocimiento que lo cita**,
y anotarlo acá con su fecha de descarga.

| Norma / documento | Nivel | Dónde (URL oficial) | Guardar como | Descargado |
|---|---|---|---|---|
| _(vacío — no hay descargas todavía)_ | | | | |

## Parte 2 — Huecos pendientes, por prioridad

### 🔴 Prioridad alta — bloquean respuestas correctas

Todo lo del **mínimo viable** de `docs/agents/guia-carga-conocimiento.md` está pendiente:

1. **IVA nacional** — ley y su reglamentación (texto vigente), régimen general de retenciones y
   percepciones, requisitos de cómputo del crédito fiscal, prorrateo. → `knowledge/nacional/iva/`
2. **Ganancias** — ley y reglamentación (texto vigente) para personas humanas y sociedades, deducciones
   personales y escala **del período en curso**, anticipos. → `knowledge/nacional/ganancias/`
3. **SIRE** — norma que lo establece y su régimen operativo (qué se informa, formato, periodicidad).
   → `knowledge/nacional/sire/`
4. **Convenio Multilateral** — texto del Convenio + régimen general (coeficiente unificado) y regímenes
   especiales; resoluciones generales de la Comisión Arbitral vigentes.
   → `knowledge/interjurisdiccional/convenio-multilateral/`
5. **IIBB de la primera provincia real** — no se puede cargar hasta saber **qué provincia** es el cliente
   piloto. Es el hueco que depende de un dato de negocio, no de trabajo de relevamiento.

### 🟡 Prioridad media

6. **RT de la FACPCE** — juego de normas contables profesionales aplicable y la variante para entes
   pequeños y medianos (**RT 41**), con **número y texto verificados** en la fuente oficial.
7. **Adopción de las RT por el Consejo Profesional** de la jurisdicción de los clientes del estudio.
8. **Ajuste por inflación** — norma aplicable, condiciones de obligatoriedad y criterio de reexpresión.
9. **Documentación técnica de los webservices** de AFIP/ARCA (autenticación, facturación electrónica,
   constatación de comprobantes, padrón), con entornos de homologación y producción diferenciados.
   → insumo de `integraciones-afip`.
10. **Secreto fiscal y protección de datos personales** — normas aplicables, con artículos, y plazos
    legales de conservación de documentación respaldatoria. → insumo de `seguridad-datos-financieros`.
11. **SIFERE** — régimen de presentación y su documentación operativa vigente.

### 🟢 Prioridad baja / incremental

12. Provincias adicionales, a medida que entren clientes con actividad en ellas.
13. Regímenes de retención y percepción **provinciales** por jurisdicción activa.
14. Regímenes especiales del Convenio para las actividades concretas de los clientes reales.
15. Convenios de corresponsabilidad, regímenes simplificados provinciales y demás particularidades que
    aparezcan con clientes reales.

## Parte 3 — Correcciones a la guía de carga

> Cuando el relevamiento contradiga lo que supone `docs/agents/guia-carga-conocimiento.md`, se anota
> acá con el hallazgo. La guía es una propuesta hecha **antes** de leer las fuentes: es esperable que
> algo no cierre. Lo que no es aceptable es que la contradicción quede sin registrar.

| # | Supuesto de la guía | Qué se encontró | Consecuencia |
|---|---|---|---|
| _(vacío)_ | | | |

## Parte 4 — Estado general de la base

| Capa | Estado |
|---|---|
| Nacional (IVA, Ganancias, SIRE) | 🔴 Carpetas creadas, **sin contenido** |
| Interjurisdiccional (Convenio Multilateral, SIFERE) | 🔴 Carpetas creadas, **sin contenido** |
| Provincial (IIBB) | 🔴 **Ninguna provincia creada** — falta saber la del cliente piloto |
| Normas técnicas (RT FACPCE) | 🔴 Sin relevar |
| Clientes (jurisdicciones activas) | 🔴 Ningún cliente cargado |

**Nada de esta base fue validado por un profesional matriculado** — no hay contenido para validar
todavía. Cuando lo haya, esa validación es el paso previo a que los agentes se usen para algo real.
