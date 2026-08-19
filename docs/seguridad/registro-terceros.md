# Registro de terceros — a quién le mandamos datos, y con qué base

> **Regla que este archivo hace cumplir (ADR-0002 R35 y §A.2.5):** mandar cualquier dato de nivel **N2 o
> superior** a un servicio externo **no lo decide un desarrollador ni un agente**: es una decisión
> explícita y registrada del titular del estudio. Si el destino no está en esta tabla, no se manda.
>
> "Servicio externo" incluye lo que no parece: correo transaccional, almacenamiento en la nube,
> analítica, error tracking (un stack trace suele traer variables locales), OCR en la nube, y **el
> contexto de un agente o LLM**. Este repo se trabaja con agentes: la regla aplica literalmente.

## Destinos autorizados

| Destino | Qué se manda | Nivel máximo | Base / motivo | Autorizado por | Fecha | Redacción aplicada |
|---|---|---|---|---|---|---|
| `api.argentinadatos.com` | `moneda` + `fecha` (parámetros de la URL de consulta — sin dato de ningún cliente) | N0 | Cotización oficial BNA pública, ya validada en producción por el proyecto hermano `control-gestion`; investigación cerrada, JP aceptó la fuente explícitamente (`docs/diseno/12-cotizacion-bna-plan.md`) | JP | 2026-08-19 | n/a — no aplica, no viaja dato de cliente |

## Destinos evaluados y rechazados

Se anotan también los que **no** se usan, con el motivo: evita que la misma discusión se vuelva a abrir
en seis meses sin memoria de por qué se dijo no.

| Destino | Para qué se evaluó | Por qué no | Fecha |
|---|---|---|---|
| _(vacío)_ | | | |

## Cómo se agrega un destino

1. Escribir la fila **antes** de escribir el código que lo usa.
2. Declarar **qué campos exactos** viajan (por nombre de columna, contra el registro de clasificación de
   `packages/shared/seguridad/clasificacion-campos.ts`), no "los datos del movimiento".
3. Confirmar que el redactor de logs y el serializador aplican la clasificación **antes** de la salida.
4. Si el destino es un procesador de datos personales por cuenta del estudio, **hay un hueco normativo
   abierto** sobre qué exige eso formalmente (ADR-0002 §G, G-2): **no tengo esa fuente cargada**. Se
   registra la decisión técnica y se marca el punto para revisar cuando la fuente esté cargada.
5. La ausencia de una fila **es** la respuesta: no hay destinos por default.
