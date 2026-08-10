# Registro de incidentes de seguridad

> **Procedimiento completo: `docs/arquitectura/ADR-0002-seguridad.md` §E.4.** Este archivo es la
> bitácora, no el procedimiento.
>
> **Orden no negociable: contener primero, entender después.** Rotar o revocar en el minuto uno; no se
> investiga con el secreto vivo. Si es una credencial fiscal, la revocación puede requerir una acción
> **del cliente** ante el organismo recaudador: contactarlo es parte del paso 1.

## Incidentes

| # | Fecha | Qué se filtró / qué pasó | Ventana de exposición | Alcance (clientes) | ¿Hay evidencia de uso? | Acciones y horarios | Control que impide la repetición | Cerrado |
|---|---|---|---|---|---|---|---|---|
| _(vacío — ningún incidente registrado)_ | | | | | | | | |

## Reglas de esta bitácora

1. **Se escribe durante el incidente, no después.** La reconstrucción de memoria pierde justo lo que
   importa: los horarios.
2. **"¿Hay evidencia de uso?" se contesta con `acceso_auditoria`** y con los logs del organismo o del
   banco. Si la respuesta es "no sabemos", eso mismo se escribe — y es un hallazgo sobre la auditoría,
   no un detalle del incidente.
3. **Un incidente no se cierra con "hay que tener más cuidado".** Se cierra con un control concreto,
   expresado como una regla verificable de ADR-0002 §B, con su número. Si no se puede expresar así, el
   incidente sigue abierto.
4. **Un secreto commiteado se considera público para siempre.** Se rota; reescribir el historial es
   opcional y posterior. Vale igual si el repo es privado.
5. **Sobre el deber legal de notificar** (a quién, en qué plazo): **no tengo esa fuente cargada**
   (ADR-0002 §G, G-3). Lo que sí se hace siempre es notificar al cliente afectado y al titular del
   estudio, por deber profesional y contractual. Ningún plazo legal se afirma acá.
