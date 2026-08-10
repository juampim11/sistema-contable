---
name: plantilla-provincia
description: Plantilla para dar de alta el IIBB de una jurisdicción. Copiar a <provincia>/iibb/README.md y completar con fuente oficial.
nivel: provincial
sources_status: plantilla
compilado: 2026-08-09
---

# PLANTILLA — IIBB de `<provincia>`

> **Cómo usarla:** copiar a `knowledge/provincial/<provincia>/iibb/README.md`, reemplazar `<provincia>`,
> y responder **cada** pregunta con su cita (norma + artículo + URL), su marca de confianza
> (`[VERIFICADO]` / `[A VERIFICAR]` / `[NO ENCONTRADO]`) y su **fecha de verificación**. Una pregunta sin
> respuesta se deja escrita como `[NO ENCONTRADO]` y se anota en `knowledge/_FUENTES.md` — **no se
> borra**: un hueco declarado es información; un hueco borrado es una trampa.
>
> **Nada de esto se completa de memoria.** Ningún número de ley, de artículo ni de alícuota.

---

## Frontmatter a poner en el archivo resultante

```yaml
---
name: <provincia>-iibb-readme
description: IIBB de <provincia> — índice, alícuotas y regímenes. Fuente oficial citada.
jurisdiccion: <provincia>
nivel: provincial
periodo_fiscal: <año que cubre>
sources_status: borrador-para-validar
compilado: <AAAA-MM-DD>
---
```

## 1. Identificación de la jurisdicción y del organismo

- Nombre oficial de la jurisdicción:
- **Organismo de recaudación** (nombre exacto vigente) y su sitio oficial:
- ¿Adhirió al Convenio Multilateral? Norma de adhesión:

## 2. Normas base

- **Código tributario / código fiscal**: norma, **texto ordenado vigente** (cuál y de qué fecha), URL:
- **Ley impositiva del año en curso**: norma, año que cubre, URL, fecha de publicación:
- ¿Hay modificatorias posteriores que afecten IIBB? Cuáles:

## 3. IIBB — lo esencial

- **Hecho imponible** y base imponible (artículos):
- **Alícuota general** y su artículo, con el período que cubre:
- **Alícuotas diferenciales por actividad** relevantes para la cartera del estudio (con su artículo o
  anexo, y el nomenclador de actividades que usa la jurisdicción):
- **Mínimos** (impuesto mínimo, si existe) y su actualización:
- **Período fiscal, anticipos y vencimientos**:

## 4. Retenciones y percepciones provinciales

- Regímenes vigentes (norma + artículo):
- ¿El cliente puede ser **agente** de retención/percepción? Condiciones:
- **Padrón de alícuotas** (si la jurisdicción lo usa): cómo se consulta, con qué periodicidad se
  actualiza, y si hay forma de consultarlo por sistema:
- Cómo se computan las **sufridas** y cómo se tratan los **saldos a favor**:

## 5. Exenciones y regímenes especiales de la jurisdicción

- Exenciones que puedan aplicar a la cartera (norma + artículo):
- Régimen simplificado provincial, si existe, y sus condiciones:
- Convenios de corresponsabilidad u otros regímenes propios:

## 6. Presentación

- ¿Cómo presenta un contribuyente **unilateral** de esta jurisdicción (sistema/portal, periodicidad)?
- ¿Y un contribuyente de **Convenio Multilateral**? (normalmente por el sistema interjurisdiccional —
  ver `knowledge/interjurisdiccional/convenio-multilateral/sifere/`)
- Formato de los datos y validaciones que rechazan una presentación:

## 7. Qué queda pendiente

Listar acá los `[NO ENCONTRADO]` y `[A VERIFICAR]`, y **replicarlos en `knowledge/_FUENTES.md`** con su
prioridad. Ese archivo es el índice único de huecos del repo.

---

## Recordatorios (no borrar al completar)

- ⚠️ **La ley impositiva es anual**: este archivo queda viejo cada año. El campo `periodo_fiscal` del
  frontmatter dice qué período cubre; si se consulta por otro, la respuesta es "no tengo esa fuente
  cargada para ese período".
- ⚠️ **Numeración del texto ordenado**: verificar el artículo contra el t.o. vigente antes de citarlo.
- ⚠️ **Sin extrapolar**: lo de esta jurisdicción no habla por ninguna otra.
- ⚠️ Todo output que use esto cierra con **"Validar con profesional matriculado"**.
