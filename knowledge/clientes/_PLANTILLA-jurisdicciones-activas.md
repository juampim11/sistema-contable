---
name: plantilla-jurisdicciones-activas
description: Plantilla del encuadre de un cliente (jurisdicciones y atributos con vigencia). Copiar a CLIENTE-<id>/jurisdicciones-activas.md.
sources_status: plantilla
compilado: 2026-08-09
---

# PLANTILLA — Encuadre de `CLIENTE-<id>`

> **Cómo usarla:** copiar a `knowledge/clientes/CLIENTE-<id>/jurisdicciones-activas.md` y completar.
> **Sin datos identificatorios ni sensibles** (ver `knowledge/clientes/README.md` §Privacidad): acá va
> el encuadre, no el legajo.
>
> **Todo es una serie con vigencia, no un valor.** Cuando un atributo cambia, **se agrega una fila** con
> la nueva vigencia; **no se edita la fila anterior**. La historia es el activo: sin ella no se puede
> recalcular un período cerrado.

---

## Frontmatter a poner en el archivo resultante

```yaml
---
name: cliente-<id>-jurisdicciones-activas
description: Encuadre fiscal de CLIENTE-<id> — jurisdicciones y atributos con vigencia.
cliente_id: <id>
sources_status: borrador-para-validar
compilado: <AAAA-MM-DD>
---
```

## 1. Encuadre de IIBB

**Régimen:** `unilateral` / `convenio-multilateral` — y desde cuándo. Si cambió, una fila por período:

| Régimen | Desde | Hasta | Respaldo |
|---|---|---|---|
| | | | |

**Jurisdicciones activas** (una fila por alta y una por cese; **no borrar** las cesadas):

| Jurisdicción | Desde | Hasta | Alta / cese | Respaldo | ¿`knowledge/provincial/<j>/iibb/` cargada? |
|---|---|---|---|---|---|
| | | — (activa) | alta | | ☐ |

> Si la columna de la derecha está en ☐, el agente de IIBB va a responder **"no tengo esa fuente
> cargada"** para esa jurisdicción. Anotar el hueco en `knowledge/_FUENTES.md`.

**Encuadre en régimen general o especial del Convenio** (si aplica), por actividad:

| Actividad | Régimen (general / especial + cita) | Desde | Hasta | Respaldo |
|---|---|---|---|---|
| | | | | |

## 2. Condición ante IVA

| Condición | Desde | Hasta | Respaldo |
|---|---|---|---|
| | | | |

## 3. Forma societaria

| Forma | Desde | Hasta | Respaldo |
|---|---|---|---|
| | | | |

## 4. Ganancias

- Sujeto: `persona humana` / `sociedad` (deriva de la forma societaria, pero se registra explícito).
- Cierre de ejercicio (mes):
- Régimen de anticipos, si tiene particularidad:

| Atributo | Valor | Desde | Hasta | Respaldo |
|---|---|---|---|---|
| | | | | |

## 5. ¿Es agente de retención / percepción?

| Régimen (nacional o provincial + cita) | Desde | Hasta | Respaldo |
|---|---|---|---|
| | | | |

> Si es agente de un régimen nacional informable por SIRE, verificar que
> `knowledge/nacional/sire/` esté cargada.

## 6. Plan de cuentas

- ¿Usa el **plan modelo** derivado, o tiene plan propio?
- Fecha de derivación / última reestructuración, y su respaldo:

## 7. Normas técnicas (para estados contables)

- Encuadre: juego completo de normas contables profesionales / variante para **entes pequeños y
  medianos (RT 41)** — con la fuente que lo habilita, **verificada**.
- Jurisdicción del **Consejo Profesional** cuya adopción de las RT aplica, y si está cargada: ☐

## 8. Huecos abiertos de este cliente

Lo que falta cargar para poder responder sobre este cliente. Replicar en `knowledge/_FUENTES.md`.

| Hueco | Prioridad | Nota |
|---|---|---|
| | | |

---

## Recordatorios (no borrar al completar)

- ⚠️ **Nunca editar una fila vigente**: se cierra con su `hasta` y se agrega la nueva.
- ⚠️ **Sin CUIT, razón social, credenciales ni importes** en este archivo.
- ⚠️ Cada dato lleva **respaldo** (referencia al documento que lo acredita) y fecha.
- ⚠️ Todo output que use esto cierra con **"Validar con profesional matriculado"**.
