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
| Decreto 409/2018 (modifica art. 13, Decreto 380/2001 — cómputo Ley 25413 a cuenta de Ganancias) | Nacional | [infoleg.gob.ar](https://servicios.infoleg.gob.ar/infolegInternet/anexos/305000-309999/309791/norma.htm) | **NO descargado como archivo** — leído vía `WebFetch`, citado en `nacional/ganancias/06-computo-a-cuenta-impuesto-creditos-y-debitos.md`. Falta guardar el HTML/PDF en `fuentes/` junto a ese archivo. | 2026-09-18 (lectura, no descarga) |
| Resolución 1/2026 SICyPyME (categorización MiPyME, topes vigentes desde 2026-04-01) | Nacional | Boletín Oficial / `pyme.produccion.gob.ar` — **NO consultada directamente**, tabla tomada de fuentes secundarias (ver `nacional/mipyme/01-categorizacion-resolucion-1-2026.md`) | **NO descargado** — hueco explícito, la tabla completa vive solo como imagen en el anexo oficial | 2026-09-18 (fuentes secundarias, no la norma en sí) |

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

### 🆕 Cargado 2026-09-18, parcial — huecos reales dentro de lo ya cargado

16. **Cómputo a cuenta de Ganancias del impuesto Ley 25413** (`nacional/ganancias/06-computo-...md`) —
    cargado y cruzado contra 3+ fuentes, con dos huecos reales sin resolver: (a) % para Mediana Tramo 2
    (ninguna fuente lo especifica); (b) discrepancia real entre fuentes sobre el límite de traslado del
    remanente para MiPyME (infoleg dice "hasta su agotamiento", ARCA dice "solo 33% del remanente").
    **No confirmado contra el texto completo del Decreto 409/2018 para el punto (b).**
17. **Categorización MiPyME — Resolución 1/2026** (`nacional/mipyme/01-categorizacion-...md`) — tabla de
    topes cargada y cruzada contra 5+ fuentes secundarias, **ninguna oficial primaria** (el anexo con
    los valores es una imagen en el Boletín Oficial, no extraíble por las herramientas de esta sesión).
    Falta además: personal ocupado para Construcción/Industria y Minería/Agropecuario, y cómo se
    calcula la "facturación anual" de un cliente concreto (¿promedio de ejercicios? ¿último ejercicio?).
    Esta carga no estaba anotada como hueco antes de esta sesión — se agrega acá recién ahora.

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
| Nacional — IVA | 🔴 Carpeta creada, **sin contenido** |
| Nacional — Ganancias | 🟡 **Un archivo cargado** (cómputo Ley 25413 a cuenta de Ganancias) — el resto (personas humanas, sociedades, deducciones, escala, anticipos) **sin contenido** |
| Nacional — SIRE | 🔴 Carpeta creada, **sin contenido** |
| Nacional — MiPyME (carpeta nueva, 2026-09-18) | 🟡 **Un archivo cargado** (topes de categorización) — solo fuentes secundarias, no la norma oficial primaria |
| Interjurisdiccional (Convenio Multilateral, SIFERE) | 🔴 Carpetas creadas, **sin contenido** |
| Provincial (IIBB) | 🔴 **Ninguna provincia creada** — falta saber la del cliente piloto |
| Normas técnicas (RT FACPCE) | 🔴 Sin relevar |
| Clientes (jurisdicciones activas) | 🔴 Ningún cliente cargado |

**Nada de esta base fue validado por un profesional matriculado** — los dos archivos cargados el
2026-09-18 fueron verificados por Claude vía búsqueda web (múltiples fuentes cruzadas), nunca contra
el Boletín Oficial descargado directamente ni por un profesional matriculado. Esa validación sigue
siendo el paso previo a que los agentes se usen para algo real con estos dos archivos.
