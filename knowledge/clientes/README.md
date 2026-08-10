---
name: clientes-readme
description: Patrón CLIENTE-<id>/ para registrar qué jurisdicciones y atributos tiene activos cada cliente. Ningún cliente cargado todavía.
sources_status: esqueleto-sin-contenido
compilado: 2026-08-09
---

# Clientes — jurisdicciones y atributos activos

> **Ningún cliente cargado.** Solo está la plantilla. Se crea la primera carpeta cuando haya un cliente
> real (empezando por el piloto).

## Para qué existe

Las carpetas de `nacional/`, `interjurisdiccional/` y `provincial/` guardan **normativa**: qué dice la
ley. Esta carpeta guarda el **puente** entre esa normativa y un cliente concreto: **qué le aplica y desde
cuándo**.

Sin este puente, un agente fiscal no puede responder nada útil, porque las dos preguntas que necesita
contestar antes de razonar son "¿qué condición tiene este cliente?" y "¿en qué jurisdicciones opera?".

## El patrón

```
knowledge/clientes/
├── README.md                              ← este archivo
├── _PLANTILLA-jurisdicciones-activas.md   ← se copia para cada cliente nuevo
└── CLIENTE-<id>/
    └── jurisdicciones-activas.md          ← qué tiene activo, desde cuándo, con qué respaldo
```

`<id>` es el **identificador interno del cliente en el sistema**, no su razón social ni su CUIT. Ver
§Privacidad más abajo.

## Varias jurisdicciones a la vez — la diferencia con un sistema mono-jurisdicción

Un cliente de **Convenio Multilateral** tiene **varias jurisdicciones activas simultáneamente**. Por eso
el archivo del cliente lleva una **tabla con vigencias**, no un campo único:

| Jurisdicción | Desde | Hasta | Alta/cese | Respaldo |
|---|---|---|---|---|
| `<provincia>` | AAAA-MM-DD | — (activa) | alta | `<documento>` |

Y lo mismo vale para los demás atributos que cambian el tratamiento (condición ante IVA, forma
societaria): **son series con vigencia, no valores**. Un recálculo de un período cerrado usa lo que
estaba vigente **entonces**. El modelo de datos que refleja esto lo define
`agents/personas/plan-cuentas-multicliente.md`; este archivo es su equivalente documental, para que los
agentes puedan razonar sobre un cliente antes de que exista una sola línea de código.

## Privacidad — qué NO va acá

Esta carpeta es de **encuadre**, no un legajo. **No** va:

- ❌ CUIT, razón social, domicilio ni ningún dato identificatorio del cliente.
- ❌ Credenciales fiscales, certificados, claves.
- ❌ Extractos bancarios, importes, deuda, estados contables.

Sí va: el **identificador interno**, sus atributos de encuadre (condición ante IVA, forma societaria,
jurisdicciones), sus vigencias y **qué documento respalda cada cambio** (referencia al documento, no el
documento). Ver `agents/personas/seguridad-datos-financieros.md`: es información alcanzada por el
secreto fiscal, y este repo no es su lugar de custodia.

## Cómo dar de alta un cliente

1. `mkdir knowledge/clientes/CLIENTE-<id>`
2. `cp knowledge/clientes/_PLANTILLA-jurisdicciones-activas.md knowledge/clientes/CLIENTE-<id>/jurisdicciones-activas.md`
3. Completar con el respaldo de cada dato (referencia al documento, con fecha).
4. Por cada jurisdicción activa: verificar que exista `knowledge/provincial/<provincia>/iibb/`. Si no
   existe, **crearla** (ver `knowledge/provincial/README.md`) o dejar anotado en `knowledge/_FUENTES.md`
   que es un hueco abierto — mientras falte, el agente de IIBB va a responder "no tengo esa fuente
   cargada" para esa jurisdicción.
